"use strict";
let path = require("path");
let fs = require("fs");
let config = require("config");
let util = require("util");
let CONFIG = config["asset"];

let appUtil = require("../util/util.js");
let Client = require("fabric-client"); // communicate with hyperledger fabric
let utils = require("fabric-client/lib/utils.js");
let User = require("fabric-client/lib/User.js");
let copService = require("fabric-ca-client/lib/FabricCAServices");

let logger = utils.getLogger("blockchainServiceHelper");
let initObjects = {};
//admin user info for set up
const ADMIN_USER = CONFIG["adminUser"];
const ADMIN_USER_ORG = CONFIG.users[ADMIN_USER].org;

//crypto setting
let cryptoSuite = Client.newCryptoSuite();
cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({ path: CONFIG["keyValueStore"] }));
const tlsOptions = {
    trustedRoots: [],
    verify: false,
};

//init object
module.exports.initObject = function (enrollId, peerAdminOrg, getAdmin, matchOrg) {
    Client.setConfigSetting("request-timeout", 60000);
    let ehs = [];
    // 1. Client 인스턴스 생성
    let client = new Client();
    let channel = {};
    let targets = [];
    //user info for set up
    const USER = CONFIG.users[enrollId];
    const USER_ORG = CONFIG.users[enrollId].org;
    //admin user name for set up
    let member = new User(enrollId);
    let targetOrg = peerAdminOrg ? peerAdminOrg : USER_ORG;

    client.setCryptoSuite(cryptoSuite);
    member.setCryptoSuite(cryptoSuite);

    //set peer form config
    // 2. 클라이언트용 KeyValueStore 설정
    return Client.newDefaultKeyValueStore({ path: CONFIG["keyValueStore"] })
        .then((store) => {
            logger.info("Setting client keyValueStore to: " + JSON.stringify(store));
            client.setStateStore(store);
            logger.info("Initialize the KeyValueStore");
            client.setStateStore(store);
            // 3. 실행 사용자 등록 및 실행 컨택스트에 사용자 설정
            return module.exports.getSubmitter(client, getAdmin, peerAdminOrg, enrollId);
        })
        .then(
            (user) => {
                // 1. 채널 구성
                logger.info("get user " + user._name);
                logger.info("new Channel");
                channel = client.newChannel(CONFIG.channel.name);

                let data = fs.readFileSync(
                    path.join(CONFIG["cert_dir"], CONFIG.orderer["tls_cacerts"])
                );
                let caroots = Buffer.from(data).toString();
                // make sure the cert is OK
                caroots = Client.normalizeX509(caroots);

                // 2. 오더러 추가
                channel.addOrderer(
                    client.newOrderer(CONFIG.orderer.url, {
                        pem: caroots,
                        "ssl-target-name-override": CONFIG.orderer["server-hostname"],
                    })
                );

                for (let key in CONFIG) {
                    // it depend on org name ..
                    matchOrg = matchOrg ? matchOrg : peerAdminOrg;
                    if (CONFIG.hasOwnProperty(key) && key.indexOf(matchOrg) === 0) {
                        for (let pr in CONFIG[key]) {
                            // add all peer in ORG
                            // 3. 채널에 각 조직의 피어를 추가
                            if (CONFIG[key].hasOwnProperty(pr) && pr.indexOf("peer") === 0) {
                                // 4. TLS 접속용 인증서 불러오기
                                let data = fs.readFileSync(
                                    path.join(CONFIG["cert_dir"], CONFIG[key][pr]["tls_cacerts"])
                                );
                                let peer = client.newPeer(CONFIG[key][pr].requests, {
                                    pem: Buffer.from(data).toString(),
                                    "ssl-target-name-override": CONFIG[key][pr]["server-hostname"],
                                });
                                channel.addPeer(peer);
                                targets.push(peer);
                                logger.info("peer added " + peer);
                                // 5. EventHub 추가
                                const eh = channel.newChannelEventHub(peer);
                                ehs.push(eh);
                            }
                        }
                    }
                }
            },
            (err) => {
                logger.error("Failed init " + err);
                throw new Error("Failed init " + err);
            }
        )
        .then(() => {
            logger.info("enroll and setContext good");
            initObjects[enrollId] = {
                client: client,
                channel: channel,
                targets: targets,
                eventhubs: ehs,
            };
            return initObjects[enrollId];
        });
};

function getMember(username, password, client, userOrg) {
    const caUrl = CONFIG[userOrg].ca.url;

    return client.getUserContext(username, true).then((user) => {
        return new Promise((resolve, reject) => {
            if (user && user.isEnrolled()) {
                return resolve(user);
            }

            const member = new User(username);
            let cryptoSuite = client.getCryptoSuite();
            if (!cryptoSuite) {
                cryptoSuite = Client.newCryptoSuite();
                if (userOrg) {
                    cryptoSuite.setCryptoKeyStore(
                        Client.newCryptoKeyStore({
                            path: module.exports.keyValueStore(CONFIG[userOrg].name),
                        })
                    );
                    client.setCryptoSuite(cryptoSuite);
                }
            }
            member.setCryptoSuite(cryptoSuite);

            // 1. fabric-ca-client/lib/FabricCAServices 생성
            const cop = new FabricCAServices(
                caUrl,
                tlsOptions,
                CONFIG[userOrg].ca.name,
                cryptoSuite
            );

            // 2. 사용자 등록
            return cop
                .enroll({
                    enrollmentID: username,
                    enrollmentSecret: password,
                })
                .then((enrollment) => {
                    // 3. 인증오브젝트(암호키와 ECert 세트)
                    return member.setEnrollment(
                        enrollment.key,
                        enrollment.certificate,
                        CONFIG[userOrg].mspid
                    );
                })
                .then(() => {
                    let skipPersistence = false;
                    if (!client.getStateStore()) {
                        skipPersistence = true;
                    }
                    // 4. 클라이언트에 사용자 컨텍스트를 설정
                    return client.setUserContext(member, skipPersistence);
                })
                .then(() => {
                    return resolve(member);
                })
                .catch((err) => {
                    logger.error(err.message);
                });
        });
    });
}

module.exports.register = function (username, secret) {
    logger.info("module.exports.register. username:" + username + " secret:" + secret);
    logger.info("register called.");

    let fabric_client = new Client();
    //admin user info for set up
    const ADMIN_USER = CONFIG["adminUser"];
    const ADMIN_USER_ORG = CONFIG.users[username].org;
    const store_path = module.exports.keyValueStore();
    let member;
    let ca_client;

    const tlsOptions = {
        trustedRoots: [],
        verify: false,
    };

    return Client.newDefaultKeyValueStore({ path: store_path })
        .then((state_store) => {
            fabric_client.setStateStore(state_store);
            let crypto_suite = Client.newCryptoSuite();
            let crypto_store = Client.newCryptoKeyStore({ path: store_path });
            crypto_suite.setCryptoKeyStore(crypto_store);
            fabric_client.setCryptoSuite(crypto_suite);
            ca_client = new copService(
                CONFIG[ADMIN_USER_ORG].ca.url,
                tlsOptions,
                CONFIG[ADMIN_USER_ORG].ca.name
            );

            if ("admin" == username) {
                return ca_client.enroll({
                    enrollmentID: ADMIN_USER,
                    enrollmentSecret: CONFIG.users[ADMIN_USER].secret,
                });
            } else {
                // 1. 등록(register)을 위해서는 관리자로 사용자 등록(enroll)을 해야 한다.
                return ca_client
                    .enroll({
                        enrollmentID: ADMIN_USER,
                        enrollmentSecret: CONFIG.users[ADMIN_USER].secret,
                    })
                    .then((enrollment) => {
                        logger.info("get admin enrollment: " + ADMIN_USER);
                        member = new User(ADMIN_USER);
                        return member.setEnrollment(
                            enrollment.key,
                            enrollment.certificate,
                            ADMIN_USER_ORG
                        );
                    })
                    .then(() => {
                        // 2. 등록을 담당할 관리 사용자를 지정하고 새로운 사용자를 등록
                        // secret 지정은 옵션
                        return ca_client.register(
                            {
                                enrollmentID: username,
                                enrollmentSecret: secret,
                                affiliation: CONFIG.users[username].org,
                                attrs: [],
                            },
                            member
                        );
                    })
                    .then((secret) => {
                        // 3. 성공적으로 등록되면 등록한 사용자의 secret이 반환된다.
                        console.log("Successfully registered " + username + " - secret:" + secret);
                        return ca_client.enroll({
                            enrollmentID: username,
                            enrollmentSecret: secret,
                        });
                    });
            }
        })
        .then((enrollment) => {
            console.log("Successfully enrolled member user " + username);
            return fabric_client.createUser({
                username: username,
                mspid: CONFIG[ADMIN_USER_ORG].mspid,
                cryptoContent: {
                    privateKeyPEM: enrollment.key.toBytes(),
                    signedCertPEM: enrollment.certificate,
                },
            });
        })
        .then((user) => {
            console.log("setUserContext user " + user._name);
            let skipPersistence = false;
            if (!fabric_client.getStateStore()) {
                skipPersistence = true;
            }
            return fabric_client.setUserContext(user, skipPersistence);
        })
        .then(() => {
            return username;
        })
        .catch((err) => {
            logger.error("Failed to register: " + err);
            if (err.toString().indexOf("Authorization") > -1) {
                logger.error(
                    "Authorization failures may be caused by having admin credentials from a previous CA instance.\n" +
                        "Try again after deleting the contents of the store directory " +
                        store_path
                );
            }
            throw new Error(err);
        });
};

function getAdmin(client, userOrg) {
    const keyPath = path.join(
        __dirname,
        util.format(
            "../../network/crypto-config/peerOrganizations/%s.example.com/users/Admin@%s.example.com/msp/keystore",
            userOrg,
            userOrg
        )
    );
    const keyPEM = Buffer.from(readAllFiles(keyPath)[0]).toString();
    const certPath = path.join(
        __dirname,
        util.format(
            "../../network/crypto-config/peerOrganizations/%s.example.com/users/Admin@%s.example.com/msp/signcerts",
            userOrg,
            userOrg
        )
    );
    const certPEM = readAllFiles(certPath)[0];

    const cryptoSuite = Client.newCryptoSuite();
    if (userOrg) {
        cryptoSuite.setCryptoKeyStore(
            Client.newCryptoKeyStore({ path: module.exports.keyValueStore() })
        );
        client.setCryptoSuite(cryptoSuite);
    }

    let username = "peer" + userOrg + "Admin";
    return client.getUserContext(username, true).then((user) => {
        if (user && user.isEnrolled()) {
            return Promise.resolve(user);
        } else {
            return Promise.resolve(
                client.createUser({
                    username: "peer" + userOrg + "Admin",
                    mspid: CONFIG[userOrg].mspid,
                    cryptoContent: {
                        privateKeyPEM: keyPEM.toString(),
                        signedCertPEM: certPEM.toString(),
                    },
                })
            );
        }
    });
}

module.exports.getSubmitter = function (client, peerOrgAdmin, org, enrollId, password) {
    if (arguments.length < 2) throw new Error('"client" and "test" are both required parameters');

    let peerAdmin, userOrg;
    if (typeof peerOrgAdmin === "boolean") {
        peerAdmin = peerOrgAdmin;
    } else {
        peerAdmin = false;
    }

    // if the 3rd argument was skipped
    if (typeof peerOrgAdmin === "string") {
        userOrg = peerOrgAdmin;
    } else {
        if (typeof org === "string") {
            userOrg = org;
        } else {
            userOrg = "org1";
        }
    }

    if (peerAdmin) {
        return getAdmin(client, userOrg);
    } else {
        // return getMember('admin', 'ry3XQB@Tk&', client, userOrg);
        return getMember(enrollId, password, client, userOrg);
    }
};

module.exports.keyValueStore = function (org) {
    let keyValueStore;
    if (org) {
        keyValueStore = CONFIG.keyValueStore + "_" + org;
    } else {
        keyValueStore = CONFIG.keyValueStore;
    }
    return keyValueStore;
};

function readAllFiles(dir) {
    const files = fs.readdirSync(dir);
    const certs = [];
    files.forEach((file_name) => {
        const file_path = path.join(dir, file_name);
        const data = fs.readFileSync(file_path);
        certs.push(data);
    });
    return certs;
}
