const dotenv = require('dotenv');
dotenv.config();

const os = require('os');
const home_dir = `${os.homedir()}/`;

const polka = require('polka');
const app = polka();

const { json } = require('body-parser');
const cors = require('cors');

const { nanoid } = require("nanoid");

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const storage = require("./utils/storage");
const fs = require('fs');

const auth = require("./utils/auth");
const { execSync } = require('child_process');

const utils = require("./utils/utils");

app.use(cors());
app.use(json());

// Log every request
function log_request(req, res, next) {
  logger.info(`~> Received ${req.method} on ${req.url}`);
  next(); // move on
}

//Add Content-Type: application/json to all responses
function add_response_headers(req, res, next) {
  res.setHeader('Content-Type', 'application/json');
  next(); // move on
}

async function authorize(req, res, next) {
  if (global.service_node_config.is_api_key_used == true) {
    const api_token = await auth.validate_token(req.headers);
    if (api_token == false) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Invalid api token" }));
    } else {
      next();
    }
  } else {
    next();
  }
}

//Add middleware
app.use(log_request, authorize, add_response_headers);

const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `info.log`
    //
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'info.log' }),
  ],
});
global.logger = logger;

//Log examples:
//logger.info('Some info');
//logger.error('Some error');

//Load config
const redis_db = require('redis');
global.service_node_config = {};
global.vpn_nodes = [];

connect_redis();
async function connect_redis() {
  global.redis_client = redis_db.createClient({ url: 'redis://127.0.0.1:6379' });
  global.redis_client.on('error', err => console.log('Redis Client Error', err));

  while (!global.redis_client.isOpen) {
    await global.redis_client.connect();
    global.logger.info('Connecting to Redis server');
  }

  //Create Redis Indexes
  try {
    await global.redis_client.ft.create('idx:services', {
      git_url: { type: redis_db.SchemaFieldTypes.TEXT, sortable: true },
      id: redis_db.SchemaFieldTypes.TEXT,
    }, {
        ON: 'HASH',
        PREFIX: 'service:',
    });
} catch (e) {
    if (e.message === 'Index already exists') {
        console.log('Index exists already, skipped creation.');
    } else {
        // Something went wrong, perhaps RediSearch isn't installed...
        console.error(e);
        process.exit(1);
    }
}

  //await client.set('key', 'value');
  /*const service_node_config = await global.redis_client.get('service_node_config');
  if (service_node_config != undefined) {
    global.service_node_config = JSON.parse(service_node_config);
    global.logger.info('Loaded node config:');
    global.logger.info(global.service_node_config);
  } else {
    //Create a new config file
    //Use env.PORT.BASE_PRIVATE_IP to generate private IPs for VPN nodes
    global.logger.info('No service_node_config has been found. Creating new...');
    global.service_node_config.hashed_tokens = [];
  }*/

  try {
    global.service_node_config = JSON.parse(fs.readFileSync(home_dir + '.deployed-config.json', 'utf8'));
    global.logger.info('Loaded node config:');
    global.logger.info(global.service_node_config);

  } catch (e) {
    global.logger.info('No config file ~/.deployed-config.json has been found');

    //Create a new config file
    //Use env.PORT.BASE_PRIVATE_IP to generate private IPs for VPN nodes
    global.service_node_config.hashed_tokens = [];
  }

  //Load data about this node from host.crt file
  var node_info = null;
  try {
    let node_info_out = execSync('./nebula-cert print -json -path /etc/nebula/host.crt', { cwd: home_dir });
    node_info = JSON.parse(node_info_out.toString()).details;
    global.logger.info('Loaded VPN node info from crt:');
    global.logger.info(node_info_out.toString());

    //Nebula uses names as server ids that's why we use nebula's node name as a server id
    global.service_node_config.server_id = node_info.name;

  } catch (err) {
    global.logger.error(`Cannot load information about this node from host.crt. Error: ${err}`);
   }

  //Load VPN nodes
  const vpn_nodes = await global.redis_client.get('vpn_nodes');
  if (vpn_nodes != undefined) {
    global.vpn_nodes = JSON.parse(vpn_nodes);
    global.logger.info('Loaded VPN nodes');
    global.logger.info(global.vpn_nodes);
  } else {
    global.logger.info('No stored VPN nodes found');
    global.vpn_nodes = [];

    //We should add the first server to vpn nodes that we just provisioned
    //Now the first server in VPN (or the first node) has a predefined private IP - 192.168.202.1
    var new_vpn_node = {};
    new_vpn_node.ip = node_info.ips[0];
    new_vpn_node.name = "load_balancer_1";
    new_vpn_node.type = ["load_balancer", "build_machine", "server"];
    new_vpn_node.id = global.service_node_config.server_id; // this is the first node - we shouldn't check that id is unique here

    global.vpn_nodes.push(new_vpn_node);
    storage.save_config();

  }

  //Load Services
  global.services = [];
  /*const services = await global.redis_client.get('services');
  if (services != undefined) {
    global.services = JSON.parse(services);
    global.logger.info('Loaded Services');
    global.logger.info(global.services);
  } else {
    global.logger.info('No stored Services found');
    global.services = [];
  }*/

  //Load Tunnels
  const tunnels = await global.redis_client.get('tunnels');
  if (tunnels != undefined) {
    global.tunnels = JSON.parse(tunnels);
    global.logger.info('Loaded Services');
    global.logger.info(global.tunnels);
  } else {
    global.logger.info('No stored Tunnels found');
    global.tunnels = [];
  }

  global.service_node_config.is_api_key_used = false; // We don't use API Tokens for API in the first version except POST /deploy/:api_token that is used to notify a service node about new git push
  generate_deploy_api_token(); // this API token is used in webhook URLs

  global.service_node_config.port = process.env.PORT || 5005;
  global.service_node_config.domain = process.env.SERVICE_NODE_DOMAIN; // We set this in deployed-service-node-install.sh script

  //Create routes
  const deployment = require("./routes/deployment");
  setInterval(deployment.check_deployment_query, 5000);
  setInterval(deployment.create_restart_query, 5000);

  //Load other modules
  const proxy = require("./routes/proxy");
  //ToDo: Only load balancers and build machines can have public domains
  //Now we just check if we set in env variable a public domain during start or not
  if (global.service_node_config.domain != undefined) {
    proxy.proxy_reload();
  }

  //Routes
  require("./routes/service")(app);
  require("./routes/tunnel")(app);
  require("./routes/deploy")(app);
  require("./routes/vpn")(app);
  require("./routes/environment")(app);

  console.log("============================================");
  console.log(utils.get_vpn_node_info(global.service_node_config.server_id));
  console.log("============================================");

  //Check if service-node works
  app.get('/hey', (req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ message: `I'm fine!` }));
  });

  app.listen(global.service_node_config.port, err => {
    if (err) throw err;
    global.logger.info(`Deployed.cc service node is running on port ${global.service_node_config.port}`);
  });

}


async function generate_deploy_api_token() {

  //Lets create a new API KEY
  global.service_node_config.api_token = crypto.randomUUID(); //ToDo: We should hide api_token after a user gets it
  global.service_node_config.hashed_tokens.push(await bcrypt.hash(global.service_node_config.api_token, 10));

  global.logger.info('New API Token is generated:');
  global.logger.info(`${global.service_node_config.api_token}`);

  storage.save_config();

}