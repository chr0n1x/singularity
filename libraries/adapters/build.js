"use strict";

var q = require('q'),
    VcsPayload = require('../payloads/vcs').VcsPayload,
    BuildPayload = require('../payloads/build').BuildPayload,
    validateBuildPayload,
    validateVcsPayload,
    validateChange,
    validateProposal,
    buildChange,
    buildProposal;

/**
 * @param {Object} buildPayload
 */
function validateBuildPayload(buildPayload) {
  new BuildPayload(buildPayload).validate();
  return buildPayload;
}

/**
 * @param {Object} vcsPayload
 */
function validateVcsPayload(vcsPayload) {
  new VcsPayload(vcsPayload).validate();
  return vcsPayload;
}

/**
 * MUST BIND `this`
 * Plugin workflow function to be bound to a plugin, returns a buildPayload
 * Triggers a build for a change, returns a build payload
 *
 * @param {Object} vcsPayload change payload (vcs payload)
 * @return {Promise} Resolves with a build payload
 */
function buildChangePayload(vcsPayload) {
  return q(vcsPayload)
  .then(validateVcsPayload)
  .then(validateChange.bind(this))
  .thenResolve(vcsPayload)
  .then(buildChange.bind(this))
  .then(validateBuildPayload);
}

/**
 * MUST BIND `this`
 * Plugin workflow function to be bound to a plugin
 * Triggers a build for a proposal, returns a build payload
 *
 * @param {Object} vcsPayload proposal payload (vcs payload)
 * @return {Promise} Resolves with a build payload
 */
function buildProposalPayload(vcsPayload) {
  return q(vcsPayload)
  .then(validateVcsPayload)
  .then(validateProposal.bind(this))
  .thenResolve(vcsPayload)
  .then(buildProposal.bind(this))
  .then(validateBuildPayload);
}

/**
 * MUST BIND `this`
 * Executes a given build plugin workflow (function to be executed in context of
 * plugin) given a VCS Payload
 *
 * @param {Function} workflow Function to execute in context of plugins
 * @param {Object} payload either a change or proposal payload (vcs payload)
 * @return {Promise} Resolving with results of publishing the build payloads
 */
function executeAndPublish(workflow, payload) {
  this.debug(
    'request for build received',
     this.logForObject(payload)
  );
  return this.executeInPlugins(workflow, payload)
  .then(function(pluginResults) {
    pluginResults.forEach(function(buildResults) {
      buildResults.forEach(function(buildPayload) {
        this.publishPayload(buildPayload);
      });
    }.bind(this));
  }.bind(this));
}

/**
 * @module adapters/build
 */
module.exports = require('./adapter').extend({
  name: 'build',
  pluginType: 'builders',

  buildChange: function(changePayload) {
    executeAndPublish.call(this, buildChangePayload, changePayload);
  },

  buildProposal: function(proposalPayload) {
    executeAndPublish.call(this, buildProposalPayload, proposalPayload);
  }
});
