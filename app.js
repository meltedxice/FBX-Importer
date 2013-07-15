/**
 * Module dependencies.
 */

var express        = require('express')
  , connect        = require('connect')
  , cookie         = require('cookie')
  , http           = require('http')
  , graph          = require('fbgraph')
  , app            = express()
  , server         = http.createServer(app)
  , conf           = require('./conf.js')
  , util           = require('./util.js')
  , fs             = require('fs')
  , mixpanel       = exports.mixpanel = require('mixpanel').init(conf.mixpanel)
  , io             = exports.io = require('socket.io').listen(server)
;

// session stuff
var SECRET = 'xanga';
var cookieParser   = express.cookieParser(SECRET);
var sessionStore   = new express.session.MemoryStore();

// map of session id to a variety of data related to a session
var SESSIONID_DATA_MAP = exports.SESSIONID_DATA_MAP = {};

// Configuration

app.configure(function() {
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(cookieParser);
  app.use(express.session({
    key: 'express.sid'
  , store: sessionStore
  }));
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

app.configure('development', function() {
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function() {
  app.use(express.errorHandler());
});

// Routes

app.get('/', function(req, res) {
  mixpanel.track('Home Page Loaded');
  res.render('index', { title: 'FBX Importer' });
});

app.get('/auth/facebook', function(req, res) {
  // we don't have a code yet
  // so we'll redirect to the oauth dialog
  if (!req.query.code) {
    var authUrl = graph.getOauthUrl({
        'client_id':     conf.fb.client_id
      , 'redirect_uri':  conf.fb.redirect_uri
      , 'scope':         conf.fb.scope
    });

    if (!req.query.error) { //checks whether a user denied the app facebook login/permissions
      res.redirect(authUrl);
    } else {  //req.query.error == 'access_denied'
      res.send('access denied');
    }
    return;
  }

  // code is set
  // we'll send that and get the access token
  graph.authorize({
      'client_id':      conf.fb.client_id
    , 'redirect_uri':   conf.fb.redirect_uri
    , 'client_secret':  conf.fb.client_secret
    , 'code':           req.query.code
  }, function (err, facebookRes) {
    res.redirect('/upload');
  });
});

// user gets sent here after being authorized
app.get('/upload', function(req, res) {
  if (!graph.getAccessToken()) {
    res.redirect('/');
    return;
  }

  mixpanel.track('Upload Page Loaded');
  graph.get('me?fields=id', function (err, res) {
    mixpanel.people.set(res.id, {
      $created: (new Date().toISOString()),
      name: res.id,
      notes_created: 0,
      notes_failed: 0,
    });
  });

  util.getPrivacySetting(function(name, privacyString) {
    res.render(
      'upload',
      {
        title: 'Upload ZIP File',
        name: name,
        privacyString: privacyString,
        errors: {}
      }
    );
  });
});

// user gets sent here after uploading a zip file
app.post('/processing', function(req, res) {
  mixpanel.track('Zip File Uploaded');
  var file = req.files.archive;

  // not sure if this is necessary..but better safe than sorry
  fs.chmod(file.path, '600');

  var errors = util.validateRequest(req.sessionID, file);

  if (errors.length === 0) {
    SESSIONID_DATA_MAP[req.sessionID] = {
      filepath: file.path,
      notes_created: 0,
      notes_failed: 0,
      num_files: 0,
      started: false,
    };
    res.redirect('/status');
  } else {
    util.getPrivacySetting(function(name, privacyString) {
      res.render(
        'upload',
        {
          title: 'Upload ZIP File',
          name: name,
          privacyString: privacyString,
          errors: errors
        }
      );
    });

    // delete the files
    fs.unlink(file.path);
  }
});

app.get('/status', function(req, res) {
  var sessionData = SESSIONID_DATA_MAP[req.sessionID];
  if (!sessionData) {
    res.redirect('/');
    return;
  }

  mixpanel.track('Status Page Loaded');

  res.render(
    'status',
    { title: 'Import Status' }
  );
});

io.set('authorization', function(data, accept){
  if (!data.headers.cookie) {
    return accept('Session cookie required.', false);
  }

  var _signed_cookies = cookie.parse(decodeURIComponent(data.headers.cookie));
  data.cookie = connect.utils.parseSignedCookies(_signed_cookies, SECRET);

  data.sessionID = data.cookie['express.sid'];

  sessionStore.get(data.sessionID, function(err, session){
    if (err) {
      return accept('Error in session store.', false);
    } else if (!session) {
      return accept('Session not found.', false);
    }

    data.session = session;
    return accept(null, true);
  });
});

io.set('log level', 1);

io.sockets.on('connection', function(socket) {
  var sessionID = socket.handshake.sessionID;

  socket.join(sessionID);

  socket.on('start processing', function() {
    util.processFile(sessionID);
  });
});

var port = process.env.PORT || 3000;
server.listen(port, function() {
  console.log('Express server listening on port %d', port);
});