/*!
 * core/twitch/api.js — the one API surface the app talks to.
 *
 * Browse data comes from Twitch's public GraphQL; this also owns the playback
 * handshake (access token -> usher master URL). Quality/variant handling is
 * intentionally left to each platform's player adapter, because hls.js, Tizen
 * AVPlay and Orsay INFOLINK each discover renditions differently; fetchVariants()
 * is provided for adapters (Orsay) that parse the master playlist themselves.
 */
(function (global) {
  'use strict';

  var TW = global.TW;
  TW.twitch = TW.twitch || {};

  function backend() { return TW.twitch.gql; }

  function withLogin(run, onFail) {
    if (!TW.auth.isLoggedIn()) { if (onFail) { onFail(-1); } return; }
    var u = TW.auth.user();
    if (u && u.login) { run(u.login); return; }
    if (TW.auth.resolveIdentity) {
      TW.auth.resolveIdentity(function (me) {
        if (me && me.login) { run(me.login); }
        else if (onFail) { onFail(-1); }
      }, onFail);
      return;
    }
    TW.twitch.helix.me(function (me) {
      if (me && me.login) { TW.auth.setIdentity(me); run(me.login); }
      else if (onFail) { onFail(-1); }
    }, onFail);
  }

  var api = {
    backendName: function () { return backend().name; },

    topStreams: function (cursor, onOk, onFail) {
      backend().topStreams(TW.config.pageSize, cursor, onOk, onFail);
    },
    topGames: function (cursor, onOk, onFail) {
      backend().topGames(TW.config.pageSize, cursor, onOk, onFail);
    },
    streamsByGame: function (game, cursor, onOk, onFail) {
      backend().streamsByGame(game, TW.config.pageSize, cursor, onOk, onFail);
    },
    categoryInfo: function (game, onOk, onFail) {
      backend().categoryInfo(game, onOk, onFail);
    },
    streamInfo: function (login, onOk, onFail) {
      backend().streamInfo(login, onOk, onFail);
    },

    // Live channels the logged-in user follows (Helix; needs login).
    followedStreams: function (cursor, onOk, onFail) {
      TW.twitch.helix.followedStreams(cursor, onOk, onFail);
    },
    // Categories the logged-in user follows that currently have live viewers.
    followedGames: function (onOk, onFail) {
      withLogin(function (login) { backend().followedGames(login, 100, onOk, onFail); }, onFail);
    },
    // Every channel the user follows, live or not (Helix; needs login). Tiles
    // carry an avatar; the Following scene subtracts the live set for "offline".
    followedChannels: function (cursor, onOk, onFail) {
      TW.twitch.helix.followedChannels(cursor, onOk, onFail);
    },

    // A channel's landing-page info (avatar, name, followers, bio).
    channelInfo: function (login, onOk, onFail) {
      backend().channelInfo(login, onOk, onFail);
    },

    // A channel's past broadcasts (VODs) and top clips.
    channelVideos: function (login, cursor, onOk, onFail) {
      backend().channelVideos(login, TW.config.pageSize, cursor, onOk, onFail);
    },
    channelClips: function (login, cursor, onOk, onFail) {
      backend().channelClips(login, TW.config.pageSize, cursor, onOk, onFail);
    },

    /**
     * Resolve a channel to an Ad-Free playable HLS master-playlist URL.
     * Cascade:
     *   1. Local TTZ Command PC Proxy (http://192.168.50.2:5000/api/twitch/master/{channel}.m3u8)
     *   2. Ad-Exempt Regional Proxy Pool (eu.luminous.dev / eu2.luminous.dev / as.luminous.dev)
     *   3. Direct Twitch GQL Token + in-player VAFT ad-segment stripper fallback
     */
    playbackUrl: function (channel, onOk, onFail) {
      var proxies = (TW.config && TW.config.adFreeProxies) ? TW.config.adFreeProxies.slice() : [];
      var cleanCh = encodeURIComponent(channel);

      function tryNextProxy(idx) {
        if (idx >= proxies.length) {
          backend().playbackToken(channel, function (token) {
            onOk(TW.twitch.usher.build(channel, token));
          }, onFail);
          return;
        }
        var candidateUrl = proxies[idx].replace('{channel}', cleanCh);
        try {
          var xhr = new XMLHttpRequest();
          var done = false;
          var timer = setTimeout(function () {
            if (done) return;
            done = true;
            try { xhr.abort(); } catch (e) {}
            tryNextProxy(idx + 1);
          }, idx === 0 ? 1600 : 2800);

          xhr.open('GET', candidateUrl, true);
          xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || done) return;
            done = true;
            clearTimeout(timer);
            var body = xhr.responseText || '';
            if (xhr.status >= 200 && xhr.status < 300 && body.indexOf('#EXTM3U') >= 0 && body.indexOf('#EXT-X-STREAM-INF') >= 0) {
              onOk(candidateUrl);
            } else {
              tryNextProxy(idx + 1);
            }
          };
          xhr.onerror = function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            tryNextProxy(idx + 1);
          };
          xhr.send();
        } catch (e) {
          tryNextProxy(idx + 1);
        }
      }

      tryNextProxy(0);
    },

    // Resolve a VOD id to a playable usher master-playlist URL.
    vodPlaybackUrl: function (vodId, onOk, onFail) {
      backend().vodPlaybackToken(vodId, function (token) {
        onOk(TW.twitch.usher.buildVod(vodId, token));
      }, onFail);
    },

    // Resolve a clip slug to a directly-playable (signed) MP4 + quality list.
    clipPlayback: function (slug, onOk, onFail) {
      backend().clipInfo(slug, onOk, onFail);
    },

    /**
     * Fetch + parse the master playlist into renditions. Used by player
     * adapters that select quality by swapping variant URLs (Orsay). onOk
     * receives an array of { name, url, bandwidth, resolution, frameRate }.
     */
    fetchVariants: function (masterUrl, onOk, onFail) {
      TW.http.request({ method: 'GET', url: masterUrl, retries: 3 },
        function (text) { onOk(TW.twitch.playlist.parseMaster(text)); },
        function (status) { if (onFail) { onFail(status); } });
    }
  };

  TW.api = api;
})(this);
