# PostgreSQL

A Model Context Protocol server that provides read-only access to PostgreSQL databases. This server enables LLMs to inspect database schemas and execute read-only queries.

## Components

### Tools

- **query**
  - Execute read-only SQL queries against the connected database
  - Input
    - `sql` (string): The SQL query to execute
    - `database` (string): Name of database for querying sql
  - All queries are executed within a READ ONLY transaction

### Resources

The server provides schema information for each table in the database:

- **Table Schemas** (`postgres://<host>/<database>/<table>/schema`)
  - JSON schema information for each table
  - Includes column names and data types
  - Automatically discovered from database metadata

## Configuration

### Usage with Claude Desktop

To use this server with the Claude Desktop app, add the following configuration to the "mcpServers" section of your `claude_desktop_config.json`:

### Docker

* when running docker on macos, use host.docker.internal if the server is running on the host network (eg localhost)
* DB username/password need to be added in `args`.
* If you want to use ssh tunnel, ssh username and password are required.

```json
{
  "mcpServers": {
    "postgres": {
      "command": "docker",
      "args": [
        "run", 
        "-i", 
        "--rm", 
        "mcp/bori-postgres",
        "db_username",
        "db_password",
        "ssh_username",
        "ssh_password"
      ]
    }
  }
}
```

## Building

Docker:

- Before build, you need to change DB host address and port in `Dockerfile`
- If you're not going to use SSH tunneling, set it to blank

```docker
ENTRYPOINT ["node", "dist/index.js", "DB_HOST", "DB_PORT", "SSH_HOST", "SSH_PORT"]
```

Then you can build with command in CMD:

```sh
docker build -t mcp/bori-postgres -f src/postgres/Dockerfile . 
```

Or just execute `build.bat` file

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
