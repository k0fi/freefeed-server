"use strict";

import * as dbAdapter from '../support/DbAdapter'

var Promise = require('bluebird')
  , uuid = require('uuid')
  , inherits = require("util").inherits
  , models = require('../models')
  , exceptions = require('../support/exceptions')
  , ForbiddenException = exceptions.ForbiddenException
  , AbstractModel = models.AbstractModel
  , User = models.User
  , mkKey = require("../support/models").mkKey
  , _ = require('lodash')

exports.addModel = function(database) {
  /**
   * @constructor
   * @extends User
   */
  var Group = function(params) {
    this.id = params.id
    this.username = params.username
    this.screenName = params.screenName
    this.createdAt = params.createdAt
    this.updatedAt = params.updatedAt
    this.isPrivate = params.isPrivate
    this.type = "group"
    this.profilePictureUuid = params.profilePictureUuid || ''
  }

  inherits(Group, User)

  Group.className = Group
  Group.namespace = "user"
  Group.initObject = Group.super_.initObject
  Group.findById = Group.super_.findById
  Group.findByIds = Group.super_.findByIds
  Group.getById = Group.super_.getById
  Group.findByAttribute = Group.super_.findByAttribute
  Group.findByUsername = Group.super_.findByUsername

  Object.defineProperty(Group.prototype, 'username', {
    get: function() { return this.username_ },
    set: function(newValue) {
      if (newValue)
        this.username_ = newValue.trim().toLowerCase()
    }
  })

  Object.defineProperty(Group.prototype, 'screenName', {
    get: function() { return this.screenName_ },
    set: function(newValue) {
      if (_.isString(newValue))
        this.screenName_ = newValue.trim()
    }
  })

  Group.prototype.isValidUsername = function(skip_stoplist) {
    var valid = this.username
        && this.username.length >= 3   // per spec
        && this.username.length <= 35  // per evidence and consensus
        && this.username.match(/^[A-Za-z0-9]+(-[a-zA-Z0-9]+)*$/)
        && models.FeedFactory.stopList(skip_stoplist).indexOf(this.username) == -1

    return valid
  }

  Group.prototype.validate = async function(skip_stoplist) {
    if (!this.isValidUsername(skip_stoplist)) {
      throw new Error('Invalid username')
    }

    if (!this.isValidScreenName()) {
      throw new Error('Invalid screenname')
    }
  }

  Group.prototype.create = async function(ownerId, skip_stoplist) {
      this.createdAt = new Date().getTime()
      this.updatedAt = new Date().getTime()
      this.screenName = this.screenName || this.username
      this.id = uuid.v4()

      var group = await this.validateOnCreate(skip_stoplist)

      let payload = {
        'username':   group.username,
        'screenName': group.screenName,
        'type':       group.type,
        'createdAt':  group.createdAt.toString(),
        'updatedAt':  group.updatedAt.toString(),
        'isPrivate':  group.isPrivate
      }
      await Promise.all([
        dbAdapter.createUserUsernameIndex(database, group.id, group.username),
        dbAdapter.createUser(database, group.id, payload)
      ])

      var stats = new models.Stats({
        id: this.id
      })

      let promises = [stats.create()]

      if (ownerId) {
        promises.push(this.addAdministrator(ownerId))
        promises.push(this.subscribeOwner(ownerId))
      }

      await Promise.all(promises)

      return this
  }

  Group.prototype.update = async function(params) {
    if (params.hasOwnProperty('screenName') && this.screenName != params.screenName) {
      if (!this.screenNameIsValid(params.screenName)) {
        throw new Error("Invalid screenname")
      }

      this.screenName = params.screenName
      this.updatedAt = new Date().getTime()

      var payload = {
        'screenName': this.screenName,
        'isPrivate':  this.isPrivate,
        'updatedAt':  this.updatedAt.toString()
      }

      await dbAdapter.updateUser(database, this.id, payload)
    }

    return this
  }

  Group.prototype.mkAdminsKey = function() {
    return mkKey(['user', this.id, 'administrators'])
  }

  Group.prototype.subscribeOwner = async function(ownerId) {
    let owner = await User.findById(ownerId)

    if (!owner) {
      return null
    }

    let timelineId = await this.getPostsTimelineId()
    let res = await owner.subscribeTo(timelineId)

    return res
  }

  Group.prototype.addAdministrator = function(feedId) {
    var that = this
    var currentTime = new Date().getTime()

    return new Promise(function(resolve, reject) {
      dbAdapter.addAdministatorToGroup(database, that.mkAdminsKey(), currentTime, feedId)
        .then(function(res) { resolve(res) })
        .catch(function(e) { reject(e) })
    })
  }

  Group.prototype.removeAdministrator = function(feedId) {
    var that = this

    return new Promise(function(resolve, reject) {
      that.getAdministratorIds()
          .then(function(adminIds) {
            if (adminIds.indexOf(feedId) == -1) {
              reject(new Error("Not an administrator"))
            }
            else if (adminIds.length == 1) {
              reject(new Error("Cannot remove last administrator"))
            }
            else {
              dbAdapter.removeAdministatorFromGroup(database, that.mkAdminsKey(), feedId)
                  .then(function(res) { resolve(res) })
                  .catch(function(e) { reject(e) })
            }
          })
    })
  }

  Group.prototype.getAdministratorIds = async function() {
    this.administratorIds = await dbAdapter.getGroupAdministratorsIds(database, this.mkAdminsKey())
    return this.administratorIds
  }

  Group.prototype.getAdministrators = async function() {
    var adminIds = await this.getAdministratorIds()
    this.administrators = await models.User.findByIds(adminIds)

    return this.administrators
  }

  /**
   * Checks if the specified user can post to the timeline of this group.
   */
  Group.prototype.validateCanPost = function(postingUser) {
    var that = this

    return this.getPostsTimeline()
        .then(function(timeline) {
          return timeline.getSubscriberIds()
        })
        .then(function(ids) {
          if (_.includes(ids, postingUser.id)) {
            return Promise.resolve(that)
          }
          return Promise.reject(new ForbiddenException(
              "You can't post to a group to which you aren't subscribed"))
        })
  }

  /**
   * Checks if the specified user can update the settings of this group
   * (i.e. is an admin in the group).
   */
  Group.prototype.validateCanUpdate = function(updatingUser) {
    var that = this

    if (!updatingUser) {
      return Promise.reject(new ForbiddenException(
        "You need to log in before you can manage groups"))
    }

    return this.getAdministratorIds().then(function(adminIds) {
      if (_.includes(adminIds, updatingUser.id)) {
        return Promise.resolve(that)
      }
      return Promise.reject(new ForbiddenException(
        "You aren't an administrator of this group"))
    })
  }

  return Group
}
