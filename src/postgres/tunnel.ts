import pg from 'pg';
import { Client as SshClient, ConnectConfig as SshConnectConfig} from 'ssh2';
import * as fs from 'fs'; // privateKey 파일을 읽기 위해 필요

// SSH 터널링 및 DB 접속 정보를 위한 인터페이스
interface DbConnectArgs {
    dbHostRemote: string;          // SSH 서버를 통해 접속할 실제 DB 서버 IP (예: 10.0.0.5)
    dbPortRemote: number;          // 실제 DB 서버 포트 (예: 5432)
    dbUser: string;
    dbPassword: string;

    sshHost: string;               // SSH 서버 호스트 (예: "your-ssh-server.com")
    sshPort?: number;              // SSH 서버 포트 (기본값: 22)
    sshUser: string;               // SSH 접속 유저
    sshPassword: string;          // SSH 비밀번호 (privateKey 사용 시 불필요)
    sshPrivateKeyPath?: string;    // SSH private key 파일 경로 (예: "~/.ssh/id_rsa")
    sshPassphrase?: string;        // Private key의 passphrase (있을 경우)
}

async function connectWithTunnel(args: DbConnectArgs): Promise<pg.PoolClient[]> {
    return new Promise(async (resolve, reject) => {
        const sshClient = new SshClient();

        const sshConfig: SshConnectConfig = {
            host: args.sshHost,
            port: args.sshPort || 22,
            username: args.sshUser,
        };

        if (args.sshPrivateKeyPath) {
            try {
                sshConfig.privateKey = fs.readFileSync(args.sshPrivateKeyPath);
                if (args.sshPassphrase) {
                    sshConfig.passphrase = args.sshPassphrase;
                }
            } catch (err) {
                return reject(new Error(`Failed to read SSH private key: ${(err as Error).message}`));
            }
        } else if (args.sshPassword) {
            sshConfig.password = args.sshPassword;
        } else {
            return reject(new Error('SSH password or private key must be provided.'));
        }

        // 터널 설정
        const tunnelOptions = {
            srcAddr: '127.0.0.1', // 로컬에서 리스닝할 주소
            srcPort: 0,           // 로컬에서 리스닝할 포트 (0으로 하면 사용 가능한 포트 자동 할당)
            dstAddr: args.dbHostRemote,             // SSH 서버에서 바라보는 실제 DB 호스트
            dstPort: args.dbPortRemote,             // SSH 서버에서 바라보는 실제 DB 포트
        };

        sshClient.on('ready', () => {
            console.log('SSH connection established.');
            sshClient.forwardOut(
                tunnelOptions.srcAddr,
                tunnelOptions.srcPort,
                tunnelOptions.dstAddr,
                tunnelOptions.dstPort,
                async (err, stream) => {
                    if (err) {
                        sshClient.end();
                        return reject(new Error(`SSH forwardOut error: ${err.message}`));
                    }

                    // 터널이 성공적으로 설정되면, stream.localPort를 통해 할당된 로컬 포트를 알 수 있음
                    const actualLocalPort = (stream as any).localPort || tunnelOptions.srcPort;
                    if (!actualLocalPort && tunnelOptions.srcPort === 0) {
                        sshClient.end();
                        return reject(new Error('Failed to get local port for tunnel.'));
                    }
                    console.log(`SSH tunnel established: ${tunnelOptions.srcAddr}:${actualLocalPort} -> ${args.dbHostRemote}:${args.dbPortRemote}`);

                    const databaseNames = [
                        "haksa_sis",
                        "canvas_production",
                    ]

                    // PostgreSQL 풀 설정 (이제 로컬 터널을 통해 접속)
                    const databaseUrls = databaseNames.map(name => {
                        return `postgres://${args.dbUser || ''}:${args.dbPassword || ''}@${tunnelOptions.srcAddr}:${actualLocalPort}/${name}`;
                    });

                    const pools = databaseUrls.map(url => {
                        return new pg.Pool({
                            connectionString: url,
                            // stream: stream, // pg는 직접 stream을 받지 않으므로 connectionString을 사용
                        });
                    });

                    try {
                        const clients = await Promise.all(pools.map(pool => pool.connect()));

                        // SSH 클라이언트와 DB 클라이언트를 함께 반환하거나,
                        // DB 클라이언트만 반환하고 SSH 클라이언트는 여기서 관리할 수 있습니다.
                        // 여기서는 DB 클라이언트만 반환하고, 필요시 SSH 클라이언트를 닫는 로직을 추가합니다.
                        // 예: client.on('end', () => sshClient.end()); client.on('error', () => sshClient.end());
                        resolve(clients);
                    } catch (dbError) {
                        console.error('PostgreSQL connection error:', dbError);
                        sshClient.end(); // DB 연결 실패 시 SSH 연결도 종료
                        reject(dbError);
                    }
                }
            );
        }).on('error', (err) => {
            reject(new Error(`SSH connection error: ${err.message}`));
        }).connect(sshConfig);
    });
}

// --- 사용 예제 ---
// async function main() {
//     // process.argv에서 인자 파싱 (기존 방식 유지 또는 더 나은 CLI 인자 파서 사용)
//     // 예시: node dist/your-script.js dbRemoteHost dbRemotePort dbUser dbPassword dbName sshHost sshUser [sshPasswordOrKeyPath] [sshKeyPassphrase] [sshPort]
//     // 실제 사용 시에는 더 견고한 인자 파싱 방법을 권장합니다. (e.g., yargs)

//     const argsFromCli = process.argv.slice(2); // 첫 두개 인자(node, script_path) 제외

//     if (argsFromCli.length < 7) {
//         console.error("Usage: <dbHostRemote> <dbPortRemote> <dbUser> <dbPassword> <dbName> <sshHost> <sshUser> [sshPassword|sshPrivateKeyPath] [sshPassphrase] [sshPort]");
//         process.exit(1);
//     }

//     const connectionArgs: DbConnectArgs = {
//         dbHostRemote: argsFromCli[0],                     // 예: "10.0.0.100" (실제 DB 서버 IP)
//         dbPortRemote: parseInt(argsFromCli[1], 10),       // 예: 5432
//         dbUser: argsFromCli[2],
//         dbPassword: argsFromCli[3],
//         sshHost: argsFromCli[5],                          // 예: "your-ssh-bastion.com"
//         sshUser: argsFromCli[6],                          // 예: "ssh_username"
//     };

//     // SSH 접속 방식에 따라 설정 (비밀번호 또는 Private Key)
//     // 이 부분은 실제 인자 처리 로직에 맞게 수정해야 합니다.
//     if (argsFromCli[7]) {
//         // 간단한 예시: 7번째 인자가 파일 경로처럼 보이면 private key로, 아니면 비밀번호로 간주
//         if (argsFromCli[7].includes('/') || argsFromCli[7].includes('\\') || argsFromCli[7].endsWith('.pem') || argsFromCli[7].endsWith('.key')) {
//             connectionArgs.sshPrivateKeyPath = argsFromCli[7];
//             if (argsFromCli[8]) { // Passphrase
//                 connectionArgs.sshPassphrase = argsFromCli[8];
//             }
//             if (argsFromCli[9]) { // SSH Port
//                 connectionArgs.sshPort = parseInt(argsFromCli[9], 10);
//             }
//         } else {
//             connectionArgs.sshPassword = argsFromCli[7];
//             if (argsFromCli[8]) { // SSH Port
//                 connectionArgs.sshPort = parseInt(argsFromCli[8], 10);
//             }
//         }
//     }


//     let haksaClient: pg.PoolClient | null = null;
//     let sshConnection: SshClient | null = null; // SSH 클라이언트 인스턴스를 저장할 변수

//     try {
//         // connectWithTunnel 함수가 SSH 클라이언트 인스턴스도 반환하도록 수정하거나,
//         // 여기서는 pg.Client만 받습니다. SSH 연결 관리는 connectWithTunnel 내부 또는 별도 로직으로 처리.
//         // 만약 sshClient를 외부에서 직접 닫고 싶다면, connectWithTunnel이 SshClient도 함께 반환하도록 수정해야 합니다.
//         // 예: const { dbClient, sshClientInstance } = await connectWithTunnel(connectionArgs);
//         // haksaClient = dbClient;
//         // sshConnection = sshClientInstance;

//         const clients = await connectWithTunnel(connectionArgs);
//         haksaClient = clients[0];

//         // 데이터베이스 작업 수행
//         const res = await haksaClient.query('SELECT NOW()');
//         console.log('Query result:', res.rows[0]);

//         // 다른 작업들...
//         // const anotherRes = await haksaClient.query('SELECT * FROM your_table LIMIT 10');
//         // console.log(anotherRes.rows);

//     } catch (error) {
//         console.error('An error occurred:', error);
//     } finally {
//         if (haksaClient) {
//             await haksaClient.release(); // 또는 client.end() (풀이 아닌 단일 클라이언트 사용 시)
//             console.log('PostgreSQL client released.');
//         }
//         // SSH 연결을 닫는 로직:
//         // connectWithTunnel 함수가 sshClient 인스턴스를 반환하도록 수정했다면 여기서 닫을 수 있습니다.
//         // if (sshConnection) {
//         //     console.log('Closing SSH connection.');
//         //     sshConnection.end();
//         // }
//         // 또는 connectWithTunnel 내부에서 관리되거나, process.exit 시 자동으로 닫히도록 할 수 있습니다.
//         // 위의 connectWithTunnel 함수 내 주석 처리된 process.on('exit', ...) 부분을 참고하세요.
//         // 그러나 명시적으로 닫는 것이 좋습니다. 이를 위해서는 connectWithTunnel이 sshClient를 반환해야 합니다.

//         // 임시로, 이 예제에서는 connectWithTunnel 내부에서 오류 발생 시 sshClient.end()를 호출하므로,
//         // 성공적인 흐름에서는 아직 열려있을 수 있습니다.
//         // 좀 더 견고한 애플리케이션에서는 SSH 클라이언트의 생명주기를 명확히 관리해야 합니다.
//         console.log('Main function finished.');
//         // 실제 애플리케이션에서는 SSH 클라이언트를 명시적으로 닫아야 리소스 누수를 방지할 수 있습니다.
//         // 예를 들어 connectWithTunnel이 { dbClient, sshClient } 객체를 반환하게 하고,
//         // finally 블록에서 sshClient.end()를 호출하는 방식입니다.
//     }
// }

// main().catch(err => {
//     console.error("Unhandled error in main:", err);
//     process.exit(1);
// });

export { connectWithTunnel };