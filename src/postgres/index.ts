#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import { connectWithTunnel } from "./tunnel.js";

const server = new Server(
    {
        name: "bori-mcp-servers/postgres",
        version: "1.0.0",
    }, 
    {
        capabilities: {
            resources: {},
            tools: {},
        },
    },
);

const args = process.argv.slice(2);

const databaseIp = args.length >= 1 ? args[0] : null;
const databasePort = args.length >= 2 ? args[1] : null;
const databaseUser = args.length >= 3 ? args[2] : null;
const password = args.length >= 4 ? args[3] : null;
const tunnelIp = args.length >= 5 ? args[4] : null;
const tunnelPort = args.length >= 6 ? args[5] : null;
const tunnelUsername = args.length >= 7 ? args[6] : null;
const tunnelPassword = args.length >= 8 ? args[7] : null;

if (!databaseIp || !databasePort || !databaseUser || !password) {
    console.error("Database arguments are required");
    process.exit(1);
}

const databaseUrl = `postgres://${databaseUser}:${password}@${databaseIp}:${databasePort}`;
const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

const haksaSisPool = new pg.Pool({
    connectionString: databaseUrl + "/haksa_sis",
});

const canvasProductionPool = new pg.Pool({
    connectionString: databaseUrl + "/canvas_production",
});

let haksaSisClient: pg.PoolClient | null = null;
let canvasProductionClient: pg.PoolClient | null = null;

try {
    if (tunnelIp && tunnelPort && tunnelUsername && tunnelPassword) {
        const clients = await connectWithTunnel({
            dbHostRemote: databaseIp,
            dbPortRemote: parseInt(databasePort),
            dbUser: databaseUser,
            dbPassword: password,
            sshHost: tunnelIp,
            sshPort: parseInt(tunnelPort),
            sshUser: tunnelUsername,
            sshPassword: tunnelPassword,
        });

        haksaSisClient = clients[0];
        canvasProductionClient = clients[1];
    } else {
        haksaSisClient = await haksaSisPool.connect();
        canvasProductionClient = await canvasProductionPool.connect();
    }
}
catch (error) {
    console.error("Error connecting to database:", error);
    process.exit(1);
}

// Function to get the appropriate pool based on database name
const getPoolClient = (database: string) => {
    switch (database) {
        case "haksa_sis":
            return haksaSisClient;
        case "canvas_production":
        default:
            return canvasProductionClient;
    }
};

// Default database to use when none specified
const DEFAULT_DATABASE = "canvas_production";
const SCHEMA_PATH = "schema";

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    // Query haksa_sis database tables
    const haksaClient = getPoolClient("haksa_sis");
    const haksaResults = await haksaClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");

    // Query canvas_production database tables
    const canvasClient = getPoolClient("canvas_production");
    const canvasResults = await canvasClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");


    // Combine results with database prefixes
    const resources = [
        // Add haksa_sis tables
        ...haksaResults.rows.map((row: any) => ({
            uri: new URL(`haksa_sis/${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
            mimeType: "application/json",
            name: `"${row.table_name}" table from haksa_sis database`,
        })),
        // Add canvas_production tables
        ...canvasResults.rows.map((row: any) => ({
            uri: new URL(`canvas_production/${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
            mimeType: "application/json",
            name: `"${row.table_name}" table from canvas_production database`,
        })),
    ];
    return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resourceUrl = new URL(request.params.uri);
    const pathComponents = resourceUrl.pathname.split("/");

    const schema = pathComponents.pop();
    const tableName = pathComponents.pop();
    const database = pathComponents.pop() || DEFAULT_DATABASE;

    if (schema !== SCHEMA_PATH) {
        throw new Error("Invalid resource URI");
    }

    const client = getPoolClient(database);

    const result = await client.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1", [tableName]);

    return {
        contents: [
            {
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(result.rows, null, 2),
            },
        ],
    };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "query",
                description: "Run a read-only SQL query",
                inputSchema: {
                    type: "object",
                    properties: {
                        sql: {
                            type: "string",
                            description: "The PostgreSQL query to run",
                        },
                        database: {
                            type: "string",
                            enum: ["haksa_sis", "canvas_production"],
                            default: "canvas_production",
                            description: "If table name starts with 'lms', use 'haksa_sis' database, otherwise use 'canvas_production' database"
                        },
                    },
                    required: ["sql", "database"]
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    if (request.params.name === "query") {
        const sql = request.params.arguments?.sql;
        const database = request.params.arguments?.database || DEFAULT_DATABASE;
        const client = getPoolClient(database);

        try {
            await client.query("BEGIN TRANSACTION READ ONLY");
            const result = await client.query(sql);
            
            return {
                content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
                isError: false,
            };
        }
        catch (error) {
            throw error;
        }
        finally {
            client
                .query("ROLLBACK")
                .catch((error) => console.warn("Could not roll back transaction:", error));
        }
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
    const transport = new StdioServerTransport();
    
    // Add event listeners for process termination
    process.on('SIGINT', () => cleanupAndExit());
    process.on('SIGTERM', () => cleanupAndExit());
    
    // Handle stdin close (client disconnection)
    process.stdin.on('close', () => {
        cleanupAndExit();
    });
    
    await server.connect(transport);
}

// Clean up function to close all connections and exit
function cleanupAndExit() {
    console.log('Shutting down server...');
    
    // Close database connections
    if (haksaSisClient) {
        haksaSisClient.release();
    }
    if (canvasProductionClient) {
        canvasProductionClient.release();
    }
    
    // Close pools
    Promise.all([
        haksaSisPool.end(),
        canvasProductionPool.end()
    ]).then(() => {
        console.log('Database connections closed.');
        process.exit(0);
    }).catch(err => {
        console.error('Error closing database connections:', err);
        process.exit(1);
    });
}

runServer().catch(console.error);
