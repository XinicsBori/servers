import pg from 'pg';
import { Client as SshClient, ConnectConfig as SshConnectConfig} from 'ssh2';
import * as net from 'net';
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
            srcPort: 50000 + Math.floor(Math.random() * 1000), // 로컬에서 리스닝할 포트
            dstAddr: args.dbHostRemote, // SSH 서버에서 바라보는 실제 DB 호스트
            dstPort: args.dbPortRemote, // SSH 서버에서 바라보는 실제 DB 포트
        };

        sshClient.on('ready', () => {
            console.log('SSH connection established.');
    
            // Create a local server to listen for connections
            const server = net.createServer((socket) => {
                sshClient.forwardOut(
                    socket.remoteAddress || '127.0.0.1',
                    socket.remotePort || 0,
                    tunnelOptions.dstAddr,
                    tunnelOptions.dstPort,
                    (err, sshStream) => {
                        if (err) {
                            console.error('SSH forward error:', err);
                            socket.end();
                            return;
                        }
                        
                        // Connect the SSH stream with the socket
                        socket.pipe(sshStream).pipe(socket);
                        
                        // Handle socket/stream closing
                        socket.on('close', () => {
                            sshStream.end();
                        });
                        
                        sshStream.on('close', () => {
                            socket.end();
                        });
                    }
                );
            });
            
            // Start the server
            server.listen(tunnelOptions.srcPort, tunnelOptions.srcAddr, async () => {
                console.log(`SSH tunnel established: ${tunnelOptions.srcAddr}:${tunnelOptions.srcPort} -> ${tunnelOptions.dstAddr}:${tunnelOptions.dstPort}`);
                
                const databaseNames = [
                    "haksa_sis",
                    "canvas_production",
                ];
                
                // Setup database connections using the tunnel
                const databaseUrls = databaseNames.map(name => {
                    return `postgres://${args.dbUser || ''}:${args.dbPassword || ''}@${tunnelOptions.srcAddr}:${tunnelOptions.srcPort}/${name}`;
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
                } catch (err) {
                    reject(new Error(`Failed to connect to databases: ${(err as Error).message}`));
                }
            });
            
            server.on('error', (err) => {
                sshClient.end();
                reject(new Error(`Local server error: ${err.message}`));
            });
        }).on('error', (err) => {
            reject(new Error(`SSH connection error: ${err.message}`));
        }).connect(sshConfig);
    });
}

export { connectWithTunnel };