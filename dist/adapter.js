'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _oracledb = require('oracledb');

var _oracledb2 = _interopRequireDefault(_oracledb);

var _utils = require('./utils');

var _utils2 = _interopRequireDefault(_utils);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _waterlineSequel = require('waterline-sequel');

var _waterlineSequel2 = _interopRequireDefault(_waterlineSequel);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var createcount = 0;

_oracledb2['default'].outFormat = _oracledb2['default'].OBJECT;

var adapter = {

  connections: new Map(),

  syncable: true,
  schema: true,

  sqlOptions: {
    parameterized: true,
    caseSensitive: false,
    escapeCharacter: '"',
    casting: false,
    canReturnValues: false,
    escapeInserts: true,
    declareDeleteAlias: false,
    explicitTableAs: false,
    prefixAlias: 'alias__',
    stringDelimiter: "'",
    rownum: true,
    paramCharacter: ':',
    convertDate: false
  },

  /**
   * This method runs when a connection is initially registered
   * at server-start-time. This is the only required method.
   *
   * @param  {[type]}   connection [description]
   * @param  {[type]}   collection [description]
   * @param  {Function} cb         [description]
   * @return {[type]}              [description]
   */
  registerConnection: function registerConnection(connection, collections, cb) {
    var _this = this;

    if (!connection.identity) return cb(new Error('no identity'));
    if (this.connections.has(connection.identity)) return cb(new Error('too many connections'));

    var cxn = {
      identity: connection.identity,
      collections: collections || {},
      schema: adapter.buildSchema(connection, collections)
    };

    // set up some default values based on defaults for node-oracledb client
    var poolMin = connection.poolMin >= 0 ? connection.poolMin : 1;
    var poolMax = connection.poolMax > 0 ? connection.poolMax : 4;
    var poolIncrement = connection.poolIncrement > 0 ? connection.poolIncrement : 1;
    var poolTimeout = connection.poolTimeout >= 0 ? connection.poolTimeout : 1;
    var stmtCacheSize = connection.stmtCacheSize >= 0 ? connection.stmtCacheSize : 30;
    var prefetchRows = connection.prefetchRows >= 0 ? connection.prefetchRows : 100;

    if (connection.maxRows > 0) {
      _oracledb2['default'].maxRows = connection.maxRows;
    }

    // set up connection pool
    _oracledb2['default'].createPool({
      user: connection.user,
      password: connection.password,
      connectString: connection.connectString,
      poolMin: poolMin,
      poolMax: poolMax,
      poolIncrement: poolIncrement,
      poolTimeout: poolTimeout,
      stmtCacheSize: stmtCacheSize
    }, function (err, pool) {
      if (err) return cb(err);
      cxn.pool = pool;
      _this.connections.set(cxn.identity, cxn);
      cb();
    });
  },

  /**
   * Construct the waterline schema for the given connection.
   *
   * @param connection
   * @param collections[]
   */
  buildSchema: function buildSchema(connection, collections) {
    return _lodash2['default'].chain(collections).map(function (model, modelName) {
      var definition = _lodash2['default'].get(model, ['waterline', 'schema', model.identity]);
      return _lodash2['default'].defaults(definition, {
        attributes: {},
        tableName: modelName
      });
    }).keyBy('tableName').value();
  },

  /**
   * Create a new table
   *
   * @param connectionName
   * @param collectionName
   * @param definition - the waterline schema definition for this model
   * @param cb
   */
  define: function define(connectionName, collectionName, definition, cb) {
    var cxn = this.connections.get(connectionName);
    var collection = cxn.collections[collectionName];
    if (!collection) return cb(new Error('No collection with name ' + collectionName));

    var queries = [];
    var query = {
      sql: 'CREATE TABLE "' + collectionName + '" (' + _utils2['default'].buildSchema(definition) + ')'
    };
    queries.push(query);

    // Handle auto-increment
    var autoIncrementFields = _utils2['default'].getAutoIncrementFields(definition);

    if (autoIncrementFields.length > 0) {
      // Create sequence and trigger queries for each one
      autoIncrementFields.forEach(function (field) {
        var sequenceName = _utils2['default'].getSequenceName(collectionName, field);
        queries.push({
          sql: 'CREATE SEQUENCE ' + sequenceName
        });
        var triggerSql = 'CREATE OR REPLACE TRIGGER ' + collectionName + '_' + field + '_trg\n                         BEFORE INSERT ON "' + collectionName + '"\n                         FOR EACH ROW\n                         BEGIN\n                         SELECT ' + sequenceName + '.NEXTVAL\n                         INTO :new."' + field + '" FROM dual;\n                         END;';

        queries.push({
          sql: triggerSql
        });
      });
    }

    // need to create sequence and trigger for auto increment
    this.executeQuery(connectionName, queries).asCallback(cb);
  },

  describe: function describe(connectionName, collectionName, cb) {
    var connectionObject = this.connections.get(connectionName);
    var collection = connectionObject.collections[collectionName];

    // have to search for triggers/sequences?
    var queries = [];
    queries.push({
      sql: 'SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = \'' + collectionName + '\''
    });
    queries.push({
      sql: 'SELECT index_name,COLUMN_NAME FROM user_ind_columns WHERE TABLE_NAME = \'' + collectionName + '\''
    });
    queries.push({
      sql: 'SELECT cols.table_name, cols.column_name, cols.position, cons.status, cons.owner\n        FROM all_constraints cons, all_cons_columns cols WHERE cols.table_name =\n        \'' + collectionName + '\' AND cons.constraint_type = \'P\' AND cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner\n        ORDER BY cols.table_name, cols.position'
    });

    return this.executeQuery(connectionName, queries).spread(function (schema, indices, tablePrimaryKeys) {
      var normalized = _utils2['default'].normalizeSchema(schema, collection.definition);
      if (_lodash2['default'].isEmpty(normalized)) {
        return cb();
      }
      cb(null, normalized);
    })['catch'](cb);
  },

  executeQuery: function executeQuery(connectionName, queries) {
    var _this2 = this;

    return new _bluebird2['default'](function (resolve, reject) {
      if (!_lodash2['default'].isArray(queries)) {
        queries = [queries];
      }
      var cxn = _this2.connections.get(connectionName);
      cxn.pool.getConnection(function (err, conn) {

        if (err && err.message.indexOf('ORA-24418') > -1) {
          // This error means all of the connections in the pool are busy
          // In this scenario, just keep trying until one of the connections frees up
          return resolve(_this2.executeQuery(connectionName, queries));
        }

        if (err) return reject(err);

        return _bluebird2['default'].reduce(queries, function (memo, query) {
          return new _bluebird2['default'](function (resolve, reject) {
            var options = {};

            // Autocommit by default
            if (query.autoCommit !== false) {
              options.autoCommit = true;
            }

            if (query.outFormat !== undefined) {
              options.outFormat = query.outFormat;
            }

            // console.log('executing', query.sql, query.params)
            conn.execute(query.sql, query.params || [], options, function (queryError, res) {
              // console.log('query result', queryError, res)
              if (queryError) return reject(queryError);
              memo.push(res);
              resolve(memo);
            });
          });
        }, []).then(function (result) {
          conn.release(function (err) {
            if (err) console.log('Problem releasing connection', err);
            resolve(_this2.handleResults(result));
          });
        })['catch'](function (err) {
          conn.release(function (error) {
            if (error) console.log('Problem releasing connection', error);
            reject(err);
          });
        });
      });
    });
  },

  handleResults: function handleResults(results) {
    return results.length == 1 ? results[0] : results;
  },

  teardown: function teardown(conn, cb) {
    if (typeof conn == 'function') {
      cb = conn;
      conn = null;
    }
    if (conn === null) {
      this.connections = {};
      return cb();
    }
    if (!this.connections.has(conn)) return cb();
    this.connections['delete'](conn);
    cb();
  },

  createEach: function createEach(connectionName, table, records, cb) {
    cb();
  },

  // Add a new row to the table
  create: function create(connectionName, table, data, cb) {
    var connectionObject = this.connections.get(connectionName);
    var collection = connectionObject.collections[table];

    var schemaName = collection.meta && collection.meta.schemaName ? _utils2['default'].escapeName(collection.meta.schemaName) + '.' : '';
    var tableName = schemaName + _utils2['default'].escapeName(table);

    // Build up a SQL Query
    var schema = connectionObject.schema;
    //var processor = new Processor(schema);

    // Prepare values
    Object.keys(data).forEach(function (value) {
      data[value] = _utils2['default'].prepareValue(data[value]);
    });

    var definition = collection.definition;
    _lodash2['default'].each(definition, function (column, name) {

      if (fieldIsBoolean(column)) {
        // no boolean type in oracle, so save it as a number
        data[name] = data[name] ? 1 : 0;
      }
    });

    var sequel = new _waterlineSequel2['default'](schema, this.sqlOptions);

    var incrementSequences = [];
    var query = undefined;

    try {
      query = sequel.create(table, data);
    } catch (e) {
      return cb(e);
    }

    var returningData = _utils2['default'].getReturningData(collection.definition);

    var queryObj = {};

    if (returningData.params.length > 0) {
      query.query += ' RETURNING ' + returningData.fields.join(', ') + ' INTO ' + returningData.outfields.join(', ');
      query.values = query.values.concat(returningData.params);
      queryObj.outFormat = _oracledb2['default'].OBJECT;
    }

    queryObj.sql = query.query;
    queryObj.params = query.values;

    this.executeQuery(connectionName, queryObj).then(function (_ref) {
      var outBinds = _ref.outBinds;

      cb(null, _utils2['default'].transformBulkOutbinds(outBinds, returningData.fields)[0]);
    })['catch'](function (err) {
      cb(err);
    });
  },

  find: function find(connectionName, collectionName, options, cb, connection) {
    var connectionObject = this.connections.get(connectionName);
    var collection = connectionObject.collections[collectionName];

    var sequel = new _waterlineSequel2['default'](connectionObject.schema, this.sqlOptions);
    var query = undefined;
    var limit = options.limit || null;
    var skip = options.skip || null;
    delete options.skip;
    delete options.limit;

    // Build a query for the specific query strategy
    try {
      query = sequel.find(collectionName, options);
    } catch (e) {
      return cb(e);
    }

    var findQuery = query.query[0];

    if (limit && skip) {
      findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER > ' + skip + ' and LINE_NUMBER <= ' + (skip + limit);
    } else if (limit) {
      findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER <= ' + limit;
    } else if (skip) {
      findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER > ' + skip;
    }

    this.executeQuery(connectionName, {
      sql: findQuery,
      params: query.values[0]
    }).then(function (results) {
      cb(null, results && results.rows);
    })['catch'](cb);
  },

  destroy: function destroy(connectionName, collectionName, options, cb, connection) {
    var _this3 = this;

    var connectionObject = this.connections.get(connectionName);
    var collection = connectionObject.collections[collectionName];

    var query = undefined;
    var sequel = new _waterlineSequel2['default'](connectionObject.schema, this.sqlOptions);

    try {
      query = sequel.destroy(collectionName, options);
    } catch (e) {
      return cb(e);
    }

    this.find(connectionName, collectionName, options, function (err, findResult) {
      _this3.executeQuery(connectionName, {
        sql: query.query,
        params: query.values
      }).then(function (delRes) {
        // verify delete?
        cb(null, findResult);
      })['catch'](function (delErr) {
        cb(delErr);
      });
    }, connection);
  },

  drop: function drop(connectionName, collectionName, relations, cb, connection) {
    var _this4 = this;

    if (typeof relations == 'function') {
      cb = relations;
      relations = [];
    }

    relations.push(collectionName);

    var queries = relations.reduce(function (memo, tableName) {
      memo.push({
        sql: 'DROP TABLE "' + tableName + '"'
      });
      var connectionObject = _this4.connections.get(connectionName);
      var collection = connectionObject.collections[tableName];

      var autoIncrementFields = _utils2['default'].getAutoIncrementFields(collection.definition);
      if (autoIncrementFields.length > 0) {
        autoIncrementFields.forEach(function (field) {
          var sequenceName = _utils2['default'].getSequenceName(tableName, field);
          memo.push({
            sql: 'DROP SEQUENCE ' + sequenceName
          });
        });
      }
      return memo;
    }, []);

    return _bluebird2['default'].resolve(this.executeQuery(connectionName, queries)).asCallback(cb);
  },

  update: function update(connectionName, collectionName, options, values, cb, connection) {
    //    var processor = new Processor();
    var connectionObject = this.connections.get(connectionName);
    var collection = connectionObject.collections[collectionName];

    // Build find query
    var sequel = new _waterlineSequel2['default'](connectionObject.schema, this.sqlOptions);

    var query = undefined;
    // Build query
    try {
      query = sequel.update(collectionName, options, values);
    } catch (e) {
      return cb(e);
    }

    var returningData = _utils2['default'].getReturningData(collection.definition);
    var queryObj = {};

    if (returningData.params.length > 0) {
      query.query += ' RETURNING ' + returningData.fields.join(', ') + ' INTO ' + returningData.outfields.join(', ');
      query.values = query.values.concat(returningData.params);
    }

    queryObj.sql = query.query;
    queryObj.params = query.values;

    // Run query
    this.executeQuery(connectionName, queryObj).then(function (_ref2) {
      var outBinds = _ref2.outBinds;

      cb(null, _utils2['default'].transformBulkOutbinds(outBinds, returningData.fields));
    })['catch'](function (err) {
      console.log('err', err);
      cb(err);
    });
  }
};

function fieldIsBoolean(column) {
  return !_lodash2['default'].isUndefined(column.type) && column.type === 'boolean';
}

exports['default'] = adapter;
module.exports = exports['default'];