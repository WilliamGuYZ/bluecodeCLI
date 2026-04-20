/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const SERVICE_NAME = 'bluecode_cli';

export const EVENT_USER_PROMPT = 'bluecode_cli.user_prompt';
export const EVENT_TOOL_CALL = 'bluecode_cli.tool_call';
export const EVENT_API_REQUEST = 'bluecode_cli.api_request';
export const EVENT_API_ERROR = 'bluecode_cli.api_error';
export const EVENT_API_RESPONSE = 'bluecode_cli.api_response';
export const EVENT_CLI_CONFIG = 'bluecode_cli.config';
export const EVENT_FLASH_FALLBACK = 'bluecode_cli.flash_fallback';
export const EVENT_NEXT_SPEAKER_CHECK = 'bluecode_cli.next_speaker_check';
export const EVENT_SLASH_COMMAND = 'bluecode_cli.slash_command';
export const EVENT_IDE_CONNECTION = 'bluecode_cli.ide_connection';
export const EVENT_CONVERSATION_FINISHED = 'bluecode_cli.conversation_finished';
export const EVENT_CHAT_COMPRESSION = 'bluecode_cli.chat_compression';
export const EVENT_MALFORMED_JSON_RESPONSE =
  'bluecode_cli.malformed_json_response';
export const EVENT_INVALID_CHUNK = 'bluecode_cli.chat.invalid_chunk';
export const EVENT_CONTENT_RETRY = 'bluecode_cli.chat.content_retry';
export const EVENT_CONTENT_RETRY_FAILURE =
  'bluecode_cli.chat.content_retry_failure';

export const METRIC_TOOL_CALL_COUNT = 'bluecode_cli.tool.call.count';
export const METRIC_TOOL_CALL_LATENCY = 'bluecode_cli.tool.call.latency';
export const METRIC_API_REQUEST_COUNT = 'bluecode_cli.api.request.count';
export const METRIC_API_REQUEST_LATENCY = 'bluecode_cli.api.request.latency';
export const METRIC_TOKEN_USAGE = 'bluecode_cli.token.usage';
export const METRIC_SESSION_COUNT = 'bluecode_cli.session.count';
export const METRIC_FILE_OPERATION_COUNT = 'bluecode_cli.file.operation.count';
export const METRIC_INVALID_CHUNK_COUNT = 'bluecode_cli.chat.invalid_chunk.count';
export const METRIC_CONTENT_RETRY_COUNT = 'bluecode_cli.chat.content_retry.count';
export const METRIC_CONTENT_RETRY_FAILURE_COUNT =
  'bluecode_cli.chat.content_retry_failure.count';
