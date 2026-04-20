# OpenAI and Anthropic API Integration

The CLI tool now supports OpenAI and Anthropic APIs as alternatives to Google's Gemini models, while maintaining full compatibility with existing MCP tools and function calling capabilities.

## Features

- **Full API compatibility**: Both OpenAI and Anthropic adapters implement the same `ContentGenerator` interface as Gemini
- **Streaming support**: Real-time response streaming for better user experience
- **Tool calling**: Complete support for MCP tools and function calls
- **Multi-modal**: Support for text and image inputs (where supported by the provider)
- **Environment-based configuration**: Easy setup through environment variables

## Setup

### OpenAI Configuration

1. Set your OpenAI API key:

```bash
export OPENAI_API_KEY="your-openai-api-key"
```

2. (Optional) Configure additional settings:

```bash
export OPENAI_BASE_URL="https://api.openai.com/v1"  # Custom base URL
export OPENAI_ORGANIZATION="your-org-id"            # Organization ID
export OPENAI_PROJECT="your-project-id"             # Project ID
export OPENAI_MODEL="gpt-4"                         # Default model
```

3. Use OpenAI authentication:

```bash
# CLI usage
bluecode-cli --auth-type=openai

# Or set environment variable for auto-detection
export OPENAI_API_KEY="your-key"
bluecode-cli  # Will automatically use OpenAI
```

### Anthropic Configuration

1. Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

2. (Optional) Configure additional settings:

```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com/v1"  # Custom base URL
export ANTHROPIC_MODEL="claude-3-5-sonnet-20241022"       # Default model
```

3. Use Anthropic authentication:

```bash
# CLI usage
bluecode-cli --auth-type=anthropic

# Or set environment variable for auto-detection
export ANTHROPIC_API_KEY="your-key"
bluecode-cli  # Will automatically use Anthropic
```

## Supported Models

### OpenAI

- GPT-4 series: `gpt-4`, `gpt-4-turbo`, `gpt-4o`
- GPT-3.5 series: `gpt-3.5-turbo`
- And other chat completion models

### Anthropic

- Claude 4: `claude-sonnet-4-20250514`, `claude-opus-4-20250514`
- Claude 3.5: `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`
- Claude 3: `claude-3-opus-20240229`, `claude-3-sonnet-20240229`, `claude-3-haiku-20240307`

## Tool Calling Compatibility

Both adapters fully support the existing MCP tool ecosystem:

### Built-in Tools

All built-in tools work seamlessly:

- File system operations (`read_file`, `write_file`, `list_directory`)
- Shell commands (`shell`)
- Web operations (`web_fetch`, `web_search`)
- Memory tools (`memory`)

### MCP Server Tools

External MCP servers work without modification:

```bash
# Configure MCP servers in settings.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/files"]
    }
  }
}
```

### Custom Tools

Function calls are automatically converted between API formats:

```typescript
// Your tool definition works with all providers
const tools = [
  {
    functionDeclarations: [
      {
        name: 'calculate',
        description: 'Perform calculations',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Math expression' },
          },
        },
      },
    ],
  },
];
```

## API Format Conversion

The adapters handle automatic conversion between different API formats:

### OpenAI → Gemini Format

- **Messages**: Converts OpenAI chat format to Gemini content format
- **Tool calls**: Maps OpenAI `tool_calls` to Gemini `functionCalls`
- **Streaming**: Converts OpenAI SSE format to Gemini streaming format

### Anthropic → Gemini Format

- **Messages**: Converts Anthropic message format to Gemini content format
- **Tool use**: Maps Anthropic `tool_use` blocks to Gemini `functionCalls`
- **Multi-modal**: Converts image formats between base64 encodings

## Examples

### Basic Usage

```bash
# Using OpenAI
export OPENAI_API_KEY="sk-..."
bluecode-cli --auth-type=openai --model=gpt-4
> Help me write a Python script

# Using Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."
bluecode-cli --auth-type=anthropic --model=claude-3-5-sonnet-20241022
> Help me analyze this code
```

### With MCP Tools

```bash
# Set up with file system tools
bluecode-cli --auth-type=openai
> Can you read the README.md file and summarize it?
# The assistant will automatically use the read_file tool

# Or with web search
> Search for the latest news about AI developments
# The assistant will use web_search tool if configured
```

### Programmatic Usage

```typescript
import { Config, AuthType } from '@google/gemini-cli-core';

// OpenAI configuration
const config = new Config('/path/to/workspace');
await config.initialize();
config.setAuthType(AuthType.USE_OPENAI);

// Anthropic configuration
const config2 = new Config('/path/to/workspace');
await config2.initialize();
config2.setAuthType(AuthType.USE_ANTHROPIC);
```

## Environment Variable Priority

The CLI auto-detects authentication method based on environment variables in this order:

1. `GOOGLE_GENAI_USE_GCA=true` → Google OAuth
2. `GOOGLE_GENAI_USE_VERTEXAI=true` → Vertex AI
3. `OPENAI_API_KEY` → OpenAI
4. `ANTHROPIC_API_KEY` → Anthropic
5. `CUSTOM_LLM_BASE_URL` → Custom LLM
6. `GEMINI_API_KEY` → Gemini

## Limitations

### OpenAI

- No native embedding API in this adapter (uses external service if needed)
- Token counting is estimated rather than exact

### Anthropic

- No embedding support (throws error if requested)
- Token counting is estimated rather than exact
- Images must be base64 encoded

## Troubleshooting

### Common Issues

1. **API Key not found**

   ```
   Error: OPENAI_API_KEY environment variable is required
   ```

   Solution: Set the appropriate API key environment variable

2. **Model not found**

   ```
   Error: OpenAI API error: 404 Not Found
   ```

   Solution: Check model name and your API access level

3. **Tool calling not working**
   - Ensure your tools are properly defined with JSON schema
   - Check that function declarations include required parameters

### Debug Mode

Enable debug logging to see API requests:

```bash
export DEBUG=true
bluecode-cli --auth-type=openai
```

This will show:

- API request/response details
- Tool call conversions
- Streaming events

## Migration from Custom LLM

If you were using the custom LLM adapter with OpenAI or Anthropic-compatible APIs:

1. **From Custom OpenAI**:

   ```bash
   # Old way
   export CUSTOM_LLM_BASE_URL="https://api.openai.com/v1"
   export CUSTOM_LLM_API_KEY="sk-..."

   # New way
   export OPENAI_API_KEY="sk-..."
   # Remove CUSTOM_LLM_* variables
   ```

2. **From Custom Anthropic**:

   ```bash
   # Old way
   export CUSTOM_LLM_BASE_URL="https://api.anthropic.com/v1"
   export CUSTOM_LLM_API_KEY="sk-ant-..."

   # New way
   export ANTHROPIC_API_KEY="sk-ant-..."
   # Remove CUSTOM_LLM_* variables
   ```

The new adapters provide better format handling and improved compatibility compared to the generic custom LLM adapter.
