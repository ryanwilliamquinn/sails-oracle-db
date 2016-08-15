var adapter = require('../../dist/adapter'),
    should = require('should'),
    support = require('./support/bootstrap');

describe('adapter', function() {

  /**
   * Setup and Teardown
   */

  before(function(done) {
    support.Setup('test_find', done);
  });

  after(function(done) {
    support.Teardown('test_find', done);
  });

  /**
   * FIND
   *
   * Returns an array of records from a SELECT query
   */

  describe('.find()', function() {

    describe('WHERE clause', function() {

      before(function(done) {
        support.Seed('test_find', done);
      });

      describe('key/value attributes', function() {

        it('should return the record set', function(done) {
          adapter.find('test', 'test_find', { where: { "field_1": 'foo' } }, function(err, results) {
            results.length.should.eql(1);
            results[0].id.should.eql(1);
            done()
          });
        });

      });

      describe('comparators', function() {

        // Insert a unique record to test with
        before(function(done) {
          var query = [
            'INSERT INTO "test_find" ("field_1", "field_2")',
            "values ('foobar', 'AR)H$daxx')"
          ].join('');

          support.Client(function(err, client) {
            client.execute(query, [], {autoCommit: true}, function(err, result) {

              // close client
              client.release((err) => {
                if (err) console.log('error releasing connection', err)
              })

              done();
            });
          });
        });

        it('should support endsWith', function(done) {

          var criteria = {
            where: {
              field_2: {
                endsWith: 'AR)H$daxx'
              }
            }
          };

          adapter.find('test', 'test_find', criteria, function(err, results) {
            results.length.should.eql(1);
            results[0].field_2.should.eql('AR)H$daxx');
            done();
          });
        });

      });

    });

    describe('it should handle arbitrary numbers of rows', function() {

      it('should find many rows', function(done)  {
        this.timeout(10000)
        support.SeedMultipleRows('test_find', 150, function() {
          console.log('seeded rows');
          adapter.find('test', 'test_find', {}, (err, results) => {
            if (err) return done(err)
            results.length.should.be.aboveOrEqual(150)
            done()
          })
        })
      })



    });


  });
});
