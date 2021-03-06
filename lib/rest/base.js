'use strict';
/*
 *   (c) Copyright 2016 Hewlett Packard Enterprise Development LP

 *   Licensed under the Apache License, Version 2.0 (the "License"); you may
 *   not use this file except in compliance with the License. You may obtain
 *   a copy of the License at

 *        http://www.apache.org/licenses/LICENSE-2.0

 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and limitations
 *   under the License.
 */

import request from 'request-promise';
import Promise from 'bluebird';
import {cacheFactory} from '../cache/cacheFactory';
import {throttle} from '../throttle/throttle';
import sha256 from 'js-sha256';
import gzip from 'gzip-js';


if (typeof(WeakMap) === 'undefined') {
    var WeakMap = require('weakmap');
}

export var _p = new WeakMap();


function isPromiseLike(obj) {
    return obj && typeof(obj.then) === 'function';
}


export class authMethod {
    constructor() {
    }
}
authMethod.BASIC = 'basic';
authMethod.SESSION = 'session';

/** Base RESTful/Redfish class */
class baseClient {
    /**
        * This class is initiated by other helper function. User won't need to initiate it directly.
    */
    constructor (baseUrl, userName='', password='',
                biosPassword=null, sessionKey=null,
                defaultPrefix='/rest/v1', timeout=60,
                concurrent=5, cacheOptions=null) {
        var whiteList = request.Request? request.Request.defaultProxyHeaderWhiteList: [];

        if (whiteList.indexOf('content-length') >= 0) {
            whiteList.splice(whiteList.indexOf('content-length'), 1);
        }
        if (whiteList.indexOf('transfer-encoding') >= 0) {
            whiteList.splice(whiteList.indexOf('transfer-encoding'), 1);
        }

        _p.set(this, {
            baseUrl: baseUrl,
            userName: userName,
            password: password,
            biosPassword: biosPassword,
            proxyHeaderWhiteList: whiteList,
            sessionKey: sessionKey,
            authorizationKey: null,
            sessionLocation: null,
            throttle: new throttle(concurrent),
            cache: cacheFactory.create((+new Date()).toString(), cacheOptions),
            rootPromise: null
        });

        this.loginUrl = null;
        this.defaultPrefix = defaultPrefix;
        this.timeout = timeout * 1000;
        this.concurrent = concurrent;
        this.connCount = 0;
        this.strictSSL = false;
        this.root = null;
    }
    getBaseUrl () {
        return _p.get(this).baseUrl;
    }
    getUserName () {
        return _p.get(this).userName;
    }
    getPassword () {
        return _p.get(this).password;
    }
    getBiosPassword () {
        return _p.get(this).biosPassword;
    }
    getSessionKey () {
        return _p.get(this).sessionKey;
    }
    getAuthorizationKey () {
        return _p.get(this).authorizationKey;
    }
    getSessionLocation () {
        return _p.get(this).sessionLocation;
    }
    /**
        * Retrieve the root object
        * @param {object} headers - Additional headers can be passed-in
        * @return {promise} A Promise object which returns the HTTP response after login
    */
    getRootObject (headers) {
        try {
            return this.get(this.defaultPrefix, null, null, headers)
                .then((res) => {
                    let statusCode = res.statusCode;
                    if (statusCode !== 200) {
                        throw Error('Server not reachable, iLO return code: ' +
                            statusCode);
                    }
                    return res;
                });
        }
        catch(e) {
            throw e;
        }
    }
    getCache () {
        return _p.get(this).cache;
    }
    /**
        * Send GET request
        * @param {string} path     - relative URI of RESTful/Redfish
        * @param {bool}   useCache - Use data from local cache or not
        * @param {object} headers  - Additional headers can be passed-in, default to null
        * @return {promise} Promise object of this GET request
    */
    get (path, args, useCache, headers=null) {
        return _p.get(this).throttle.run(() => {
            var options = this.__formOptions(path, 'GET', args, null, headers,
                            null, null);

            return this.__doRequest(options, useCache);
        });
    }
    /**
        * Send POST request
        * @param {string} path     - relative URI of RESTful/Redfish
        * @param {object} body     - body
        * @param {string} providerHeader - Perhaps we should hide this one?
        * @return {promise} Promise object of this POST request
    */
    post (path, body, providerHeader) {
        return _p.get(this).throttle.run(() => {
            var options;

            options = this.__formOptions(path, 'POST', null, body, null,
                                null, providerHeader);

            return this.__doRequest(options);
        });
    }
    /**
        * Send PUT request
        * @param {string} path     - relative URI of RESTful/Redfish
        * @param {object} body     - body
        * @param {string} optionalPassword     - Optional password
        * @param {string} providerHeader - Perhaps we should hide this one?
        * @return {promise} Promise object of this PUT request
    */
    put (path, body, optionalPassword, providerHeader) {
        return _p.get(this).throttle.run(() => {
            var options;

            options = this.__formOptions(path, 'PUT', null, body, null,
                        optionalPassword, providerHeader);

            return this.get(path).then((res) => {
                if ((res.statusCode >= 200 && res.statusCode <= 299) &&
                    (res.headers['content-encoding'] === 'gzip')) {
                        // Going to gzip the body

                        // Set type to json, but it's gzip format
                        // Let json to false, avoid requests to be confused
                        options.headers['Content-Type'] = 'application/json';
                        options.json = false;
                        options.body = new Buffer(gzip.zip(
                                JSON.stringify(options.body)));
                }

                return this.__doRequest(options);
            });
        });
    }
    /**
        * Send PATCH request
        * @param {string} path     - relative URI of RESTful/Redfish
        * @param {object} body     - body
        * @param {string} optionalPassword     - Optional password
        * @param {string} providerHeader - Perhaps we should hide this one?
        * @return {promise} Promise object of this PATCH request
    */
    patch (path, body, optionalPassword, providerHeader) {
        return _p.get(this).throttle.run(() => {
            var options;

            options = this.__formOptions(path, 'PATCH', null, body, null,
                            optionalPassword, providerHeader);

            return this.__doRequest(options);
        });
    }
    delete (path, optionalPassword, providerHeader) {
        return _p.get(this).throttle.run(() => {
            var options = this.__formOptions(path, 'DELETE', null, null, null,
                            optionalPassword, providerHeader);

            return this.__doRequest(options);
        });
    }
    __getReqHeaders (headers={}, providerHeader=null,
            optionalPassword=null) {
        headers = headers && typeof(headers) === 'object' ? headers : {};
        if (providerHeader) {
            headers['X-CHRP-RIS-Provider-ID'] = providerHeader;
        }

        if (this.getBiosPassword()) {
            headers['X-HPRESTFULAPI-AuthToken'] = sha256(
                    this.getBiosPassword()).toUpperCase();
        }
        else if (optionalPassword) {
            headers['X-HPRESTFULAPI-AuthToken'] = sha256(
                    optionalPassword).toUpperCase();
        }

        if (this.getSessionKey()) {
            headers['X-Auth-Token'] = this.getSessionKey();
        }
        else if (this.getAuthorizationKey()) {
            headers['X-Auth-Token'] = this.getAuthorizationKey();
        }

        headers['Connection'] = 'keep-alive';

        return headers;
    }
    __formOptions (path, method='GET', args=null, body=null, headers=null,
            optionalPassword=null, providerHeader=null) {
        var options,
            jsonBody, urlEncodeBody,
            json = true,
            reqPath,
            baseUrl = this.getBaseUrl();

        if (!path) {
            throw Error('URI incorrect: ' + path);
        }
        reqPath = path.replace('//', '/');
        headers = this.__getReqHeaders(headers, providerHeader,
                optionalPassword);

        options = {
            baseUrl: baseUrl,
            method: method,
            timeout: this.timeout,
            strictSSL: this.strictSSL,
            followAllRedirects: true,
            tunnel: true,
            proxyHeaderWhiteList: _p.get(this).proxyHeaderWhiteList,
            gzip: process.browser? false : true,
            resolveWithFullResponse: true
        };

        if (body) {
            try {
                jsonBody = JSON.stringify(body);
            }
            catch(e) {
                urlEncodeBody = body.toString();
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                json = false;
            }
            options.body = body;
        }
        options.json = json;
        options.uri = reqPath;
        options.headers = headers;

        return options;
    }
    __doRequest (options={}, useCache=false) {
        var cache = _p.get(this).cache,
            cachedResp, _resolve, _reject;
        var promise = new Promise(function (resolve, reject) {
            _resolve = resolve;
            _reject = reject;
        });

        function resolvePromise (res) {
            var statusCode = res.statusCode;
            (statusCode >= 200 && statusCode < 300 ? _resolve : _reject)(res);
        }

        if (useCache && options.method === 'GET') {
            cachedResp = cache.get(options.uri);
            if (cachedResp !== undefined) {
                if (isPromiseLike(cachedResp)) {
                    // Got a Promise
                    cachedResp.then(resolvePromise, resolvePromise);
                }
                else {
                    // Got a real response
                    resolvePromise(cachedResp);
                }
            }
            else {
                // No data cached
                cache.put(options.uri, promise);
            }
        }
        if (cachedResp === undefined) {
            request(options)
                .then((res) => {
                    // If this is a GET then update cache
                    if (options.method === 'GET') {
                        let statusCode = res.statusCode,
                            uri = options.uri;

                        if (statusCode >= 200 && statusCode < 300) {
                            cache.put(uri, res.toJSON());
                        }
                        else {
                            cache.remove(uri);
                        }
                    }
                    resolvePromise(res.toJSON());
                    return res;
                })
                .catch((res) => {
                    cache.remove(res.options.uri);
                    resolvePromise(res);
                });
        }

        return promise;
    }
    /**
        * Login to the RESTful/Redfish API
        * @param {string} userName - Your iLO user account
        * @param {string} password - Password for your account
        * @return {promise} A Promise object which returns the HTTP response after login
    */
    login (userName='', password='', auth=authMethod.SESSION) {
        return _p.get(this).rootPromise
            .then(() => this.__doLogin(userName, password, auth));
    }
    __doLogin (userName='', password='', auth=authMethod.SESSION) {
        var __userName = this.getUserName();
        var __password = this.getPassword();

        if (typeof(userName) === 'string') {
            __userName = userName;
            _p.get(this).userName = userName;
        }
        if (typeof(password) === 'string') {
            __password = password;
            _p.get(this).password = password;
        }

        _p.get(this).sessionKey = null;
        _p.get(this).authorizationKey = null;
        if (auth === authMethod.BASIC) {
            let encBase64 = new Buffer(
                    (__userName + ':' + __password)).toString('base64');
            let authKey = 'Basic ' + encBase64;
            _p.get(this).authorizationKey = authKey;

            return this.get(this.loginUrl);
        }
        else if (auth === authMethod.SESSION) {
            let body = {};

            body.UserName = __userName;
            body.Password = __password;

            return this.post(this.loginUrl, body)
                .then((res) => {
                    var _json = res;
                    _p.get(this).sessionKey = _json.headers['x-auth-token'];
                    _p.get(this).sessionLocation = _json.headers['location'];
                    return res;
                });
        }
        else {
            throw Error('No matching authorize method');
        }

        return;
    }
    /**
     * Logout
     * @return {promise} A Promise object which returns the HTTP response after logout
     */
    logout () {
        var __sessionLocation = this.getSessionLocation();
        var path = this.defaultPrefix + __sessionLocation.split(
                this.defaultPrefix)[1];

        return this.delete(path)
            .then((res) => {
                if (res.statusCode === 200) {
                    _p.get(this).sessionKey = null;
                    _p.get(this).sessionLocation = null;
                    _p.get(this).authorizationKey = null;
                    return res;
                }
                else {
                    throw Error('Logout failed');
                }
            });
    }
}

export {baseClient};
