var Logger = require('./log'),
    Db = require('./db'),
    fs = require('fs'),
    path = require('path'),
    express = require('express');

module.exports = function(config, log) {

  var app = express(),
      standardizeConfig = function(config) {
        if (!config.plugins) {
          config.plugins = {};
        }

        if (!config.plugins.github) {
          config.plugins.github = {};
        }

        if (!config.plugins.github.repos) {
          config.plugins.github.repos = [];
        }

        if (!config.plugins.jenkins) {
          config.plugins.jenkins = {};
        }

        if (!config.plugins.jenkins.projects) {
          config.plugins.jenkins = [];
        }

        if (!config.plugins.jenkins.push_projects) {
          config.plugins.jenkins.push_projects = {};
        }

        return config;
      };

  app.config = standardizeConfig(config || {});
  app.log = log || new Logger(config.log_level || 'debug');
  app.db = Db.init(config.db, app.log);
  app.listeners = [];

  app.attemptDbConfigLoad = function(callback) {
    callback = callback || function() {};

    if (!app.db) {
      app.log.info('no db connection, loading config from file');
      callback();
      return;
    }

    if (!app.config.persist_config) {
      app.log.info('warning: "persist_config" option is off; config will always be loaded from file');
      app.db.getSingularityConfig(function(err, storedConfig) {
        if (err) {
          callback();
          return;
        }

        if (storedConfig && Object.keys(storedConfig).length > 0) {
          app.log.info('Found a configuration in the DB! "persist_config" must be true to load it; Using file');
        }
      });

      callback();
      return;
    }

    app.db.getSingularityConfig(function(err, storedConfig) {
      if (err) {
        app.log.error('Singularity: could not get db config, continuing to use file', err);
        callback();
        return;
      }

      if (!storedConfig || Object.keys(storedConfig).length === 0) {
        app.db.saveSingularityConfig(config, function(err, res) {
          if (err) {
            app.log.error('initial config db write failed', err);
            process.exit(1);
          }

          app.log.error('stored config is empty; using file, storing config');
        });

        callback();
        return;
      }

      app.config = storedConfig;
      app.log.info('Singularity: Using stored application configuration');
      callback();
    });
  };

  app.loadListeners = function(directories) {
    if (!Array.isArray(directories)) {
      throw new Error('directories must be array');
    }

    directories.forEach(function(dir) {
      fs.readdir(dir, function(err, files) {
        if (err) {
          app.log.error(err);
          process.exit(1);
        }

        if (!app.config.plugins) {
          app.log.info('No plugin configurations found - skipping');
          return;
        }

        for (var i = 0, l = files.length; i < l; i++) {
          var filename = path.join(dir, files[i]),
              pluginName = files[i].split('.', 2)[0];

          if (!filename.match(/\.js$/)) {
            continue;
          }

          if (!app.config.plugins[pluginName]) {
            app.log.info('No configuration for ' + pluginName + ', not loading');
            continue;
          }

          var pluginEnabled = app.config.plugins[pluginName].enabled;

          if (pluginEnabled === undefined || pluginEnabled) {
            app.log.info('Loading plugin: ' + pluginName);
            app.listeners.push(require(filename).init(app.config.plugins[pluginName], app).start());
          }
          else {
            app.log.info('Not loading disabled plugin ' + pluginName);
          }
        }
      });
    });
  };

  app.getConfig = function() {
    if (!app.config || !app.config.plugins) {
      return {};
    }

    var selectData = {},
        configs = app.config.plugins,
        formatProjectCfg = function(projects) {
          if (!projects && !Array.isArray(projects) && !(projects instanceof Object)) {
            return [];
          }
          var ret = [];
          for (var repo in projects) {
            ret.push({
              name: projects[repo].name,
              repo: !isNaN(parseInt(repo)) ? projects[repo].repo : repo,
              has_trigger_token: !!projects[repo].token
            });
          }
          return ret;
        };

    if (configs.github) {
      selectData.github = {};
      selectData.github.ci_user = (configs.github.auth) ? configs.github.auth.username : false;
      selectData.github.repositories = configs.github.repos || [];
    }

    if (configs.jenkins) {
      selectData.jenkins = {};
      selectData.jenkins.has_global_trigger_token = !!configs.jenkins.token;
      selectData.jenkins.projects = formatProjectCfg(configs.jenkins.projects);
      selectData.jenkins.push_projects = formatProjectCfg(configs.jenkins.push_projects);
    }

    return selectData;
  };

  app.addRepo = function(params) {
    if (app.config.plugins.github.repos.indexOf(params.repo) !== -1) {
      app.log.info('duplicate github repo', params);
      return false;
    }

    app.emit('github.new_repo', params.repo);
    return true;
  };

  app.addRepoPRJob = function(params) {
    var duplicate = app.config.plugins.jenkins.projects.some(function(project) {
      return (params.project === project.name || params.repo === project.repo);
    });

    if (duplicate) {
      app.log.info('duplicate jenkins repo or project', params);
      return false;
    }

    app.addRepo(params);

    app.emit('jenkins.new_pr_job', {
      name: params.project,
      repo: params.repo,
      token: params.token || false
    });
    app.log.info('Singularity: runtime config updated');

    return true;
  };

  app.addRepoPushJob = function(params) {
    var duplicate = app.config.plugins.jenkins.push_projects.some(function(project) {
      return (params.project === project.name || params.repo === project.repo);
    });

    if (duplicate) {
      app.log.info('duplicate jenkins repo or project', params);
      return false;
    }

    app.addRepo(params);

    app.emit('jenkins.new_push_job', {
      name: params.project,
      repo: params.repo,
      token: params.token || false,
      rules: params.rules.map(function(rule) {
        return new RegExp(rule);
      })
    });
    app.log.info('Singularity: runtime config updated');

    return true;
  };

  app.getDomain = function() {
    return (app.config.host || 'localhost') + ':' + (app.config.port || '80');
  };

  app.on('singularity.configuration.updated', function(plugin) {
    if (!app.config.persist_config) {
      app.log.info('not persisting config changes', { requesting_plugin: plugin });
    }

    app.db.saveSingularityConfig(app.config, function(err, res) {
      if (err) {
        app.log.error('error saving runtime configuration, exiting!', { error: err });
        process.exit(1);
      }

      app.log.info('Singularity: saved config into DB', { notifying_plugin: plugin });
    });
  });

  app.removeRepoConfigs = function(repo) {
    var pr_projects = app.config.plugins.jenkins.projects,
    push_projects = app.config.plugins.jenkins.push_projects,
    repos = app.config.plugins.github.repos;
    app.config.plugins.jenkins.projects = pr_projects.filter(function(project) {
      return project.repo !== repo;
    });
    app.config.plugins.jenkins.push_projects = push_projects.filter(function(project) {
      return project.repo !== repo;
    });
    app.config.plugins.github.repos.splice(repos.indexOf(repo), 1);
    app.reloadConfigs();
  };

  app.removePushProjectConfigs = function() {
    app.config.plugins.jenkins.push_projects = [];
    app.reloadConfigs();
  };

  app.removePullProjectConfigs = function() {
    app.config.plugins.jenkins.projects = [];
    app.reloadConfigs();
  };

  app.removeProjectConfigs = function(project) {
    if (!project) {
      app.removePullProjectConfigs();
      app.removePushProjectConfigs();
      return;
    }
    var pr_projects = app.config.plugins.jenkins.projects,
    push_projects = app.config.plugins.jenkins.push_projects;
    app.config.plugins.jenkins.projects = pr_projects.filter(function(pjt) {
      return pjt.name !== project;
    });
    app.config.plugins.jenkins.push_projects = push_projects.filter(function(pjt) {
      return pjt.name !== project;
    });
    app.reloadConfigs();
  };

  app.reloadConfigs = function() {
    app.emit('jenkins.config_reload', app.config.plugins.jenkins);
    app.emit('github.config_reload', app.config.plugins.github);
  };

  return app;
};
