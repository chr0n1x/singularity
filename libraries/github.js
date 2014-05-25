"use strict";

var GitHubApi = require('github'),
async = require('async'),
q = require('q');

module.exports = require('nbd/Class').extend({
  publisher: null,

  publish: function(topic, data) {
    if (!this.publisher) {
      this.error('cannot publish topic, no channel', arguments);
      return;
    }

    this.publisher(topic, data);
  },

  init: function(option) {
    this.config = option;
    this._api = new GitHubApi({
      version: '3.0.0',
      host: option.host,
      port: option.port
    });
    this.error = this.error.bind(this);
  },

  addRepo: function(data) {
    if (!data.repo || !data.organization) {
      throw 'Missing repo or organization in passed data';
    }

    if (!this.config.repos) {
      this.config.repos = [];
    }

    this.log.info('GitHub Lib: adding repo', repo);
    this.config.repos.push(repo);

    return this.setupRepoHook(repo);
  },

  error: function(error) {
    this.log.error(error);
  },

  /**
   * Sets up the GitHub plugin. Depending on the selecting configs either a webserver
   * will be setup for receiving webhook events or asynchronous polling will be setup.
   *
   * @method start
   */
  start: function() {
    if (this.config.method === 'hooks') {
      this.checkRepos();
      return this;
    }

    var self = this;
    async.parallel({
      github: function() {
        var run_github = function() {
          self.checkRepos();
          setTimeout(run_github, self.config.frequency);
        };

        run_github();
      }
    });

    return this;
  },

  authenticate: function() {
    this.log.debug('Polling github for new and updated Pull Requests');
    this._api.authenticate(this.config.auth);
  },

  /**
   * Iterates over the configured list of repositories and uses the GitHub API to check each one for pull requests.
   *
   * @method checkRepos
   */
  checkRepos: function() {
    this.log.debug('Polling github for new and updated Pull Requests');

    return q.allSettled(this.config.repos.map(function(repo) {
      // Getting PRs for each repo
      return q.ninvoke(this._api.pullRequests, 'getAll', {
        user: this.config.user,
        repo: repo,
        state: 'open'
      })
      .then(function getPR(resp) {
        return q.allSettled(Object.keys(resp)
        .map(function(i) { return resp[i]; })
        .filter(function(pull) {
          return pull.number && pull.number !== 'undefined';
        })
        .map(function getPRDetails(pull) {
          // Currently the GitHub API doesn't provide the same information for polling as
          // it does when requesting a single, specific, pull request. So we have to
          return q.ninvoke(this._api.pullRequests, 'get', {
            user: this.config.user,
            repo: repo,
            number: pull.number
          })
          .then(function(pull) {
            this.publish('pull_request', pull);
          }.bind(this));
        }, this));
      }.bind(this))
      .catch(this.error);
    }, this));
  },

  /**
   * Uses the GitHub API to pull the list of files and diffs for the provided pull request.
   * These will be parsed and saved on the pull object to be saved to the database later.
   *
   * @method checkFiles
   * @param pull {Object}
   */
  checkFiles: function(pull) {
    this.log.debug('Checking files for pull request', { pull_number: pull.number, repo: pull.repo });

    return q.ninvoke(this._api.pullRequests, 'getFiles', {
      user: this.config.user,
      repo: pull.repo,
      number: pull.number
    })
    .then(function(files) {
      pull.files = files
      .filter(function(file) {
        return file.filename && file.filename !== 'undefined';
      })
      .map(function(file) {
        var start = null,
        length = null,
        deletions = [],
        modified_length,
        offset = 0,
        line_number = 0;

        file.ranges = [];
        file.reported = [];
        file.sha = file.blob_url.match(/blob\/([^\/]+)/)[1];

        // The GitHub API doesn't return the actual patch when it's exceedingly large
        if (file.patch) {
          file.patch.split('\n').forEach(function(line) {
            var matches = line.match(/^@@ -\d+,\d+ \+(\d+),(\d+) @@/);
            if (matches) {
              if (start == null && length == null) {
                start = parseInt(matches[1], 10);
                length = parseInt(matches[2], 10);
                line_number = start;
              }
              else {
                // The one is for the line in the diff block containing the line numbers
                modified_length = 1 + length + deletions.length;
                file.ranges.push([start, start + length, modified_length, offset, deletions]);

                deletions = [];
                start = parseInt(matches[1], 10);
                length = parseInt(matches[2], 10);
                offset += modified_length;
                line_number = start;
              }
            }
            else if (line.indexOf('-') === 0) {
              deletions.push(line_number);
            }
            else {
              line_number += 1;
            }
          });
        }

        if (start != null && length != null) {
          file.ranges.push([start, start + length, 1 + length + deletions.length, offset, deletions]);
        }

        return file;
      });

      if (pull.files.length > 0) {
        this.publish('pull.found', pull);
      }
      else {
        this.log.info('Skipping pull request, no modified files found', { pull_number: pull.number, repo: pull.repo });
      }
    }.bind(this))
    .catch(this.error);
  },

  /**
   * Starts the process of processing a pull request. Will retrieve the pull request from the database or insert a new
   * record for it if needed. The pull request is then checked to see if it should be processed or not and dispatches
   * the appropriate event if so.
   *
   * @method processPull
   * @param pull {Object}
   */
  processPull: function(pull) {
    var self = this;
    this.application.db.findPull(pull.number, pull.repo, function(error, item) {
      if (!pull.head || !pull.head.repo) {
        self.log.error('Skipping pull request, invalid payload given', { pull_number: pull.number, repo: pull.repo });
        return;
      }

      var new_pull = false,
      ssh_url = pull.head.repo.ssh_url,
      branch = pull.head.label.split(':')[1];

      if (!item) {
        new_pull = true;
        self.application.db.insertPull(pull, function(err) {
          if (err) {
            self.log.error(err);
            process.exit(1);
          }
        });
        pull.jobs = [];
      }
      else {
        // Before updating the list of files in db we need to make sure the set of reported lines is saved
        item.files.forEach(function(file) {
          pull.files.forEach(function(pull_file, i) {
            if (pull_file.filename === file.filename) {
              pull.files[i].reported = file.reported;
            }
          });
        });
        self.application.db.updatePull(pull.number, pull.repo, { files: pull.files });
        pull.jobs = item.jobs;
      }

      if (new_pull || pull.head.sha !== item.head) {
        self.publish('pull.processed', pull, pull.number, pull.head.sha, ssh_url, branch, pull.updated_at);
        return;
      }

      if (typeof pull.skip_comments !== 'undefined' && pull.skip_comments) {
        self.publish('pull.processed', pull, pull.number, pull.head.sha, ssh_url, branch, pull.updated_at);
        return;
      }

      self._api.issues.getComments({
        user: self.config.user,
        repo: pull.repo,
        number: pull.number,
        per_page: 100
      },
      function(error, resp) {
        for (var i in resp) {
          if (i === 'meta') {
            continue;
          }

          var comment = resp[i];
          if (
            self.config.retry_whitelist &&
              self.config.retry_whitelist.indexOf(comment.user.login) === -1 &&
                comment.user.login !== pull.head.user.login
          ) {
            continue;
          }

          if (comment.created_at > item.updated_at && comment.body.indexOf('@' + self.config.auth.username + ' retest') !== -1) {
            self.publish('pull.processed', pull, pull.number, pull.head.sha, ssh_url, branch, pull.updated_at);
            return;
          }
        }
      });
    });
  },

  /**
   * Uses the GitHub API to create a Merge Status for a pull request.
   *
   * @method createStatus
   * @param sha {String}
   * @param user {String}
   * @param repo {String}
   * @param state {String}
   * @param build_url {String}
   * @param description {String}
   */
  createStatus: function(sha, user, repo, state, build_url, description) {
    this.log.info('creating status ' + state + ' for sha ' + sha + ' for build_url ' + build_url);
    this.authenticate();
    return q.ninvoke(this._api.statuses, 'create', {
      user: user,
      repo: repo,
      sha: sha,
      state: state,
      target_url: build_url,
      description: description
    })
    .catch(this.error);
  },

  /**
   * Uses the GitHub API to create an inline comment on the diff of a pull request.
   *
   * @method createComment
   * @param pull {Object}
   * @param sha {String}
   * @param file {String}
   * @param position {String}
   * @param comment {String}
   */
  createComment: function(pull, sha, file, position, comment) {
    this.authenticate();
    if (!file && !position && !comment) {
      return q.ninvoke(this._api.issues, 'createComment', {
        user: this.config.user,
        repo: pull.repo,
        number: pull.number,
        body: sha
      })
      .catch(this.error);
    }
    else {
      return q.ninvoke(this._api.pullRequests, 'createComment', {
        user: this.config.user,
        repo: pull.repo,
        number: pull.number,
        body: comment,
        commit_id: sha,
        path: file,
        position: position
      })
      .catch(this.error);
    }
  },

  /**
   * Receives a pull request at the very beginning of the process, either from a webhook event or from the REST API,
   * and checks to make sure we care about it.
   *
   * @method handlePullRequest
   * @param pull {Object}
   */
  handlePullRequest: function(pull) {
    // Check if this came through a webhooks setup
    if (pull.action !== undefined) {
      var base_repo_name = pull.pull_request.base.repo.name;

      if (pull.action === 'closed') {
        this.application.db.updatePull(pull.number, base_repo_name, { status: pull.action });
        if (pull.pull_request.merged) {
          this.log.debug('pull was merged, skipping');
          this.publish('pull.merged', pull);
          this.application.db.updatePull(pull.number, base_repo_name, { status: 'merged' });
        }
        else {
          this.log.debug('pull was closed, skipping');
          this.publish('pull.closed', pull);
        }

        return;
      }

      if (pull.action !== 'synchronize' && pull.action !== 'opened') {
        this.log.debug('Not building pull request, action not supported', { pull_number: pull.number, action: pull.action });
        return;
      }

      pull = pull.pull_request;
    }

    // During testing there were cases where the mergeable flag was null when using webhooks.
    // In that case we want to allow the build to be attempted. We only want to prevent it when
    // the mergeable flag is explicitly set to false.
    if (pull.mergeable !== undefined && pull.mergeable === false) {
      this.log.debug('Not building pull request, not in mergeable state', { pull_number: pull.number, mergeable: pull.mergeable });
      return;
    }

    if (pull.body && pull.body.indexOf('@' + this.config.user + ' ignore') !== -1) {
      this.log.debug('Not building pull request, flagged to be ignored', { pull_number: pull.number });
      return;
    }

    pull.repo = pull.base.repo.name;
    if (this.config.skip_file_listing) {
      this.log.debug('skipping file listing for PR');
      pull.files = [];
      this.publish('pull.found', pull);
    }
    else {
      this.checkFiles(pull);
    }
  },

  /**
   * Receives an issue comment from a webhook event and checks to see if we need to worry about it. If so the
   * associated pull request will be loaded via the REST API and sent on its way for processing.
   *
   * @method handleIssueComment
   * @param comment {Object}
   */
  handleIssueComment: function(comment) {
    // This event will pick up comments on issues and pull requests but we only care about pull requests
    if (comment.issue.pull_request.html_url == null) {
      this.log.debug('Ignoring non-pull request issue notification');
      return;
    }

    if (!~comment.comment.body.indexOf('@' + this.config.auth.username + ' retest')) { return; }

    this.log.debug('Received retest request for pull', { pull_number: comment.issue.number, repo: comment.repository.name });

    return q.ninvoke(this._api.pullRequests, 'get', {
      user: this.config.user,
      repo: comment.repository.name,
      number: comment.issue.number
    })
    .then(function(pull) {
      pull.skip_comments = true;
      this.publish('pull_request', pull);
    }.bind(this))
    .catch(this.error);
  },

  /**
   * Processes & validates push events
   *
   * @method handlePush
   * @param payload {Object}
   */
  handlePush: function(payload) {
    var self = this;

    if (!payload.repository.name || !payload.ref || !payload.before || !payload.after || !payload.pusher.name || !payload.pusher.email) {
      self.log.error('Invalid push payload event', payload);
      return;
    }

    self.application.db.findPush(payload.repository.name, payload.ref, payload.after, function(err, item) {
      var log_item = { repo: payload.repository.name, ref: payload.ref, sha: payload.after };

      if (err) {
        self.log.error(err);
        return;
      }

      if (item) {
        self.log.debug('Push event already triggered.', log_item);
        return;
      }

      self.log.debug('Push event found', log_item);
      self.application.db.insertPush(payload, function(err, res) {
        if (err) {
          self.log.error(err);
          return;
        }
        self.publish('push.found', payload);
      });
    });
  },

  /**
   * Create / configure webhooks for a given list of repos
   *
   * @method setupRepoHook
   * @param repos {Array}
   */
  setupRepoHook: function(repo, callback) {
    if (~this.config.repos.indexOf(repo)) {
      if (callback) {
        callback('repo already configured', null);
      }
      return q.reject('repo already configured');
    }

    return this.createWebhook(repo, callback)
    .catch(function(err) {
      if (callback) {
        callback('Failed to create webhook', { repo: repo, error: err });
      }
      this.error('Failed to create webhook');
      throw { repo: repo, error: err };
    });
  },

  /**
   * Create webhook for a given repo
   *
   * @param repo {String}
   * @method createWebhook
   */
  createWebhook: function(repo, callback) {
    var promise = q.ninvoke(this._api.repos, 'createHook', {
      user: this.config.user,
      repo: repo,
      name: 'web',
      active: true,
      events: [
        'pull_request',
        'issue_comment',
        'push'
      ],
      config: {
        url: this.application.getDomain(),
        content_type: 'json'
      }
    });

    if (callback) {
      promise.done(function(res) {
        callback(null, res);
      });
    }

    return promise;
  }
});
