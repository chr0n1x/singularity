var Logger = require('../../libraries/log'),
    sinon = require('sinon'),
    assert = require('assert'),
    chai = require('chai'),
    expect = chai.expect,
    Emitter = require('events').EventEmitter,
    Jenkins = require('../../listeners/jenkins');

chai.use(require('sinon-chai'));

describe('listeners/jenkins', function() {
  var test = this;
  test.mongoPush = require('../fixtures/mongo_push');

  beforeEach(function(done) {
    test.events = new Emitter();
    test.app = new Emitter();
    test.app.log = new Logger('debug');
    test.generator = {v1: function() { return 'test-id'; }};
    test.config = {
      protocol: 'http',
      host: 'myjenkins.host.com',
      token: 'global_test_token',
      push_projects: [
        {
          repo: 'test_repo',
          name: 'test_project',
          token: 'test_token'
        }
      ]
    };
    test.jenkins = Jenkins.init(test.config, test.app, test.generator);
    test.mockPush = {
      repository: { name: 'test_repo' },
      before: 'before_sha',
      ref: 'test_ref',
      after: 'after_sha'
    };

    done();
  });

  describe('start', function() {
    it('it does not when there is no db connection', function() {
      var prJobSpy = sinon.spy(),
          pushJobSpy = sinon.spy(),
          logSpy = sinon.spy();

      sinon.stub(test.jenkins, 'checkPRJob', prJobSpy);
      sinon.stub(test.jenkins, 'checkPushJob', pushJobSpy);
      sinon.stub(test.app.log, 'error', logSpy);

      test.jenkins.start();

      expect(logSpy).to.have.been.calledOnce;
      expect(prJobSpy).to.not.have.been.called;
      expect(pushJobSpy).to.not.have.been.called;
    });
  });

  describe('buildPush', function() {
    it('triggers builds with expected params', function() {
      var triggerSpy = sinon.spy(),
          expected_opts = {
            token: 'test_token',
            cause: 'test_ref updated to after_sha',
            BRANCH_NAME: 'test_branch',
            BEFORE: 'before_sha',
            AFTER: 'after_sha',
            JOB: 'test-id'
          };

      sinon.stub(test.jenkins, 'triggerBuild', triggerSpy);

      test.jenkins.buildPush(test.mockPush, 'test_branch');

      assert(triggerSpy.withArgs('test_project', expected_opts).calledOnce);
    });
  });

  describe('getJobBuilds', function() {
    it('formats & filters responses correctly', function() {
      var jenkinsBuilds = require('../fixtures/jenkins_builds.json'),
          requestStub = function(opt, cb) {
            cb(null, jenkinsBuilds);
          };
      test.jenkins = Jenkins.init(test.config, test.app, test.generator, requestStub);
      test.jenkins.getJobBuilds('should_not_matter', function(err, builds) {
        expect(builds.length).to.be.equal(1);
        expect(builds[0].parameters).to.be.an('Array');
        expect(builds[0].url).to.contain('consoleFull');
      });
    });
  });

  describe('checkPushJob', function() {
    it('returns when no build for push', function() {
      var getBuildSpy = sinon.spy();

      sinon.stub(test.jenkins, 'getBuildById', getBuildSpy);

      expect(test.jenkins.checkPushJob(test.mongoPush)).to.be.undefined;
    });

    it('reacts to progressing build correctly', function() {
      var getBuildStub = sinon.stub(test.jenkins, 'getBuildById'),
          dbSpy = sinon.spy();

      test.jenkins.application.db = { updatePushJobStatus: function() {} };
      sinon.stub(test.jenkins.application.db, 'updatePushJobStatus', dbSpy);
      getBuildStub.callsArgWith(2, null, { building: true });

      test.jenkins.checkPushJob(test.mongoPush);
      expect(dbSpy).to.have.been.calledOnce;
      expect(dbSpy).to.have.been.calledWithExactly(test.mongoPush.job.id, 'started', 'BUILDING');
    });

    it('updates finished build statuses', function() {
      var getBuildStub = sinon.stub(test.jenkins, 'getBuildById'),
          dbSpy = sinon.spy(),
          logSpy = sinon.spy(),
          emitSpy = sinon.spy(),
          artifactSpy = sinon.spy();

      test.jenkins.application.db = { updatePushJobStatus: function() {} };
      test.jenkins.application.log = { debug: function() {} };
      sinon.stub(test.jenkins.application, 'emit', emitSpy);
      sinon.stub(test.jenkins.application.db, 'updatePushJobStatus', dbSpy);
      sinon.stub(test.jenkins.application.log, 'debug', logSpy);
      sinon.stub(test.jenkins, 'processArtifacts', artifactSpy);
      getBuildStub.callsArgWith(2, null, { building: false, result: "FAILURE" });

      expect(test.jenkins.checkPushJob(test.mongoPush)).to.be.undefined;
      expect(dbSpy).to.have.been.calledOnce;
      expect(dbSpy).to.have.been.calledWithExactly(test.mongoPush.job.id, 'finished', 'FAILURE');
      expect(emitSpy).to.have.been.calledOnce;
      expect(emitSpy).to.have.been.calledWith('push.build.failure');
      expect(logSpy).to.have.been.calledOnce;
      expect(artifactSpy).to.have.been.calledOnce;
    });
  });

  describe('getBuildById', function() {
    it('returns false on connection issue', function() {
      var jobBuildsStub = sinon.stub(test.jenkins, 'getJobBuilds');

      jobBuildsStub.callsArgWith(1, 'test-error', 'wat');

      test.jenkins.getBuildById('some-project', 'id-dont-matter', function(err, res) {
        expect(err).to.be.null;
        expect(res).to.be.false;
      });

      jobBuildsStub.callsArgWith(1, null, null);

      test.jenkins.getBuildById('some-project', 'id-dont-matter', function(err, res) {
        expect(err).to.be.null;
        expect(res).to.be.false;
      });
    });

    it('returns a build', function() {
      var jobBuildsStub = sinon.stub(test.jenkins, 'getJobBuilds');

      jobBuildsStub.callsArgWith(1, null, [require('../fixtures/jenkins_builds.json').body.builds[0]]);

      test.jenkins.getBuildById('project-dont-matter',
      'fpood350-dur7-11e3-barf-foo4d3ff4728',
      function(err, build) {
        expect(err).to.be.null;
        expect(build.parameters).to.contain({name: 'JOB', value: 'fpood350-dur7-11e3-barf-foo4d3ff4728'});
      });
    });
  });
});
