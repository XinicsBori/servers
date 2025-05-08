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
if (args.length < 2) {
    console.error("Please provide a database user and password as command-line arguments");
    process.exit(1);
}

const databaseIp = args[0];
const databasePort = args[1];
const databaseUser = args.length >= 3 ? args[2] : null;
const password = args.length >= 4 ? args[3] : null;

if (!databaseUser || !password) {
    console.error("Database user and password are required");
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

// Function to get the appropriate pool based on database name
const getPool = (database: string) => {
    switch (database) {
        case "haksa_sis":
            return haksaSisPool;
        case "canvas_production":
        default:
            return canvasProductionPool;
    }
};

// Default database to use when none specified
const DEFAULT_DATABASE = "canvas_production";
const SCHEMA_PATH = "schema";

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    // Query haksa_sis database tables
    const haksaClient = await haksaSisPool.connect();
    let haksaResults;
    
    try {
        haksaResults = await haksaClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    }
    finally {
        haksaClient.release();
    }

    // Query canvas_production database tables
    const canvasClient = await canvasProductionPool.connect();
    let canvasResults;
    try {
        canvasResults = await canvasClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    }
    finally {
        canvasClient.release();
    }

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
    const pool = getPool(database);
    const client = await pool.connect();
    try {
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
    }
    finally {
        client.release();
    }
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
        const pool = getPool(database);
        const client = await pool.connect();
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
            client.release();
        }
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

runServer().catch(console.error);
