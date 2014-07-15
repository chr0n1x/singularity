"use strict";

var postal = require('postal'),
    q = require('q'),
    path = require('path'),
    fs = require('fs');

/**
 * MUST BIND `this`
 * Validates that `this` has plugins
 */
function validateHasPlugins() {
  if (this.plugins.length === 0) {
    throw 'no plugins attached';
  }
}

/**
 * MUST BIND `this`
 * Validates that a config for a plugin exists
 *
 * @param {String} plugin Name of the plugin
 * @return {Object} Config for plugin
 */
function validatePluginCfg(adapter, plugin, config) {
  if (!config[plugin]) {
    throw 'No config for ' + adapter + '.' + plugin;
  }
  return config[plugin];
}

/**
 * Generate an internally recognized path to where a plugin
 * *should* be
 *
 * @param {String} type type of plugin
 * @param {String} name Name of the plugin
 * @return {String} Supposed path to plugin
 */
function internalPluginPath(type, name) {
  return path.join(__dirname, '..', 'plugins', type, name + '.js');
}

/**
 * MUST BIND `this`
 * Generates a path for the plugin
 * Prefers cfg.plugin_path over the internally generated path
 * (via `internalPluginPath`)
 *
 * @param {String} plugin Name of the plugin
 * @return {String} Path to plugin
 * @throws String when neither cfg path or internal path exists
 */
function pathFromName(plugin) {
  var cfgPath = this.config.plugin_path,
      filePath = internalPluginPath(this.pluginType, plugin);
      cfgPath = cfgPath && fs.existsSync(cfgPath) ? cfgPath : false;

  if (!cfgPath && !fs.existsSync(filePath)) {
    throw 'plugin_path cfg not defined (or does not exist) & ' +
      filePath +
      ' does not exist';
  }
  return (cfgPath) ? cfgPath : filePath;
}

/**
 * MUST BIND `this`
 * Attempts to load a plugin, pushes it into this.plugins
 *
 * @param {String} path Path of plugin to load
 */
function loadFromPath(plugin, path, config) {
  var Klass = require(path),
  instance = new Klass(config);
  instance.log = this.log;
  this.plugins.push(instance);
}

module.exports = require('../vent').extend({
  channel: undefined,
  objectType: 'adapter',

  setChannel: function(channelName) {
    this.channel = postal.channel(channelName);
  },

  /**
   * {@inheritDoc}
   * @param {Object} option Configuration
   */
  init: function(option) {
    // used to build out paths to plugins (if none given)
    if (!this.pluginType) {
      throw 'No pluginType defined';
    }
    this._super(option);
    this.plugins = [];
    this.executeInPlugins = this.executeInPlugins.bind(this);
    this.publishPayload = this.publishPayload.bind(this);
    this.setChannel = this.setChannel.bind(this);
    this.setChannel(this.name);
  },

  publishPayload: function(payload) {
    if (!payload) {
      this.error('no payload given...?!');
      return;
    }
    if (!payload.type) {
      this.error('payload has no type!', payload);
      return;
    }
    this.channel.publish(payload.type, payload);
  },

  /**
   * Given a config, attempts to load plugins based on it.
   * If a `plugin` field exists, this fx will exclusively attempt
   * to load that plugin
   *
   * @param {undefined | Object} customCfgs Defaults to this.config
   */
  attachConfigPlugins: function(customCfgs) {
    var self = this,
        plugins,
        cfg = customCfgs || this.config;

    if (cfg.plugin) {
      plugins = Array.isArray(cfg.plugin) ? cfg.plugin : [cfg.plugin];
    }
    else {
      plugins = Object.keys(cfg).filter(function(key) {
        key !== 'plugin';
      });
    }

    return q.allSettled(
      plugins.map(function(plugin) {
        self.debug(
          'plugin_load',
          {plugin: plugin}
        );
        return self.attachPlugin(plugin);
      })
    )
    .done(
      function(res) {
        if (self.start) {
          self.debug('starting...');
          return self.start();
        }
        self.debug('no start method');
      }
    );
  },

  /**
   * @param {String} plugin Name of the plugin
   * @return {Promise}
   */
  attachPlugin: function(plugin) {
    var pluginCfg = this.config[plugin];
    return q([this.name, plugin, this.config])
    .spread(validatePluginCfg)
    .thenResolve(plugin)
    .then(pathFromName.bind(this))
    .then(function(path) { return [plugin, path, pluginCfg]; })
    .spread(loadFromPath.bind(this))
    .catch(this.error);
  },

  /**
   * Takes a callback executes it in the context of each plugin
   *
   * @param {Function} callback The function to call on each plugin
   * @param {*} data Argument to invoke callback with
   * @return {*[]} arr of results for each plugin that the callback was
   *               invoked for
   */
  executeInPlugins: function(callback, data) {
    return q.fcall(validateHasPlugins.bind(this))
    .thenResolve(
      this.plugins.map(function(plugin) {
        return q(data)
        .then(callback.bind(plugin))
        .catch(plugin.error);
      })
    )
    .then(q.all)
    .catch(function(err) {
      this.error(err);
      return [];
    }.bind(this));
  }
});
