#!/usr/bin/env node

/**
 * Example demonstrating OpenAI and Anthropic API usage with the CLI tool
 * This example shows how to use the new adapters with MCP tools and function calling
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Example environment setup
const examples = {
  openai: {
    env: {
      OPENAI_API_KEY: 'sk-your-openai-api-key-here',
      OPENAI_MODEL: 'gpt-4',
    },
    prompts: [
      'List the files in the current directory and tell me what this project does',
      'Can you help me write a simple Python function to calculate fibonacci numbers?',
      'Search for information about the latest developments in AI and summarize them',
    ],
  },
  anthropic: {
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-your-anthropic-api-key-here',
      ANTHROPIC_MODEL: 'claude-3-5-sonnet-20241022',
    },
    prompts: [
      'Analyze the code structure of this project and suggest improvements',
      'Help me debug this JavaScript function that is not working correctly',
      'Create a comprehensive README for this project based on the existing files',
    ],
  },
};

function createExampleConfig(provider, baseDir) {
  const config = {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', baseDir],
        trust: false,
      },
      web_search: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-web-search'],
        trust: false,
      },
    },
  };

  const configPath = join(__dirname, `settings-${provider}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function runExample(provider, prompt, configPath) {
  console.log(
    `\n🤖 Testing ${provider.toUpperCase()} with prompt: "${prompt}"`,
  );
  console.log('='.repeat(80));

  const env = { ...process.env, ...examples[provider].env };

  try {
    // Use the CLI with the specified auth type
    const command = `npx bluecode-cli --auth-type=${provider} --config="${configPath}" --non-interactive "${prompt}"`;

    console.log(`Running: ${command}`);
    const result = execSync(command, {
      env,
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
    });

    console.log('Response:');
    console.log(result);
  } catch (error) {
    console.error(`❌ Error running ${provider} example:`, error.message);

    // Show setup instructions if API key is missing
    if (error.message.includes('API_KEY')) {
      console.log(`\n📝 Setup instructions for ${provider.toUpperCase()}:`);
      console.log(
        `export ${provider.toUpperCase()}_API_KEY="your-api-key-here"`,
      );
      if (provider === 'openai') {
        console.log(
          'Get your API key from: https://platform.openai.com/api-keys',
        );
      } else if (provider === 'anthropic') {
        console.log('Get your API key from: https://console.anthropic.com/');
      }
    }
  }
}

function main() {
  console.log('🚀 OpenAI and Anthropic Integration Examples');
  console.log('This example demonstrates the new LLM adapters with MCP tools');

  const baseDir = process.cwd();

  // Check if API keys are available
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasOpenAI && !hasAnthropic) {
    console.log('\n⚠️  No API keys found. Please set at least one:');
    console.log('export OPENAI_API_KEY="sk-your-openai-key"');
    console.log('export ANTHROPIC_API_KEY="sk-ant-your-anthropic-key"');
    console.log('\nThen run this example again.');
    return;
  }

  // Test each provider that has an API key
  if (hasOpenAI) {
    console.log('\n✅ OpenAI API key found - running OpenAI examples');
    const configPath = createExampleConfig('openai', baseDir);

    examples.openai.prompts.forEach((prompt) => {
      runExample('openai', prompt, configPath);
    });
  }

  if (hasAnthropic) {
    console.log('\n✅ Anthropic API key found - running Anthropic examples');
    const configPath = createExampleConfig('anthropic', baseDir);

    examples.anthropic.prompts.forEach((prompt) => {
      runExample('anthropic', prompt, configPath);
    });
  }

  console.log('\n🎉 Example completed!');
  console.log('\nKey features demonstrated:');
  console.log('✓ OpenAI and Anthropic API integration');
  console.log('✓ MCP tool calling (filesystem, web search)');
  console.log('✓ Environment-based authentication');
  console.log('✓ Streaming responses');
  console.log('✓ Function call compatibility');
}

// Run the example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { examples, createExampleConfig, runExample };
