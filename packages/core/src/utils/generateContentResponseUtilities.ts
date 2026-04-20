/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentResponse,
  Part,
  FunctionCall,
} from '@google/genai';
import { getResponseText } from './partUtils.js';

/**
 * Attempts to parse a JSON object from an LLM text response that may contain
 * Markdown code fences (``` or ```json) or surrounding text. Returns the
 * parsed object on success, otherwise throws the original parse error.
 */
export function tryParseJsonFromText(text: string): Record<string, unknown> {
  const cleaned = text
    // Remove BOM and zero-width spaces
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();

  // Fast path
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    void 0; // ignore parse errors in fast path
  }

  // Try to strip markdown fences ```json ... ``` or ``` ... ```
  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    const inner = fencedMatch[1].trim();
    try {
      return JSON.parse(inner) as Record<string, unknown>;
    } catch {
      void 0; // ignore parse errors in fenced content
    }
  }

  // As a last resort, extract substring between the first '{' and the last '}'
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      void 0; // ignore parse errors in brace-delimited content
    }
  }

  // Give up – throw a parse error resembling JSON.parse
  throw new Error('Failed to parse JSON from model text.');
}

export function getResponseTextFromParts(parts: Part[]): string | undefined {
  if (!parts) {
    return undefined;
  }
  const textSegments = parts
    .map((part) => part.text)
    .filter((text): text is string => typeof text === 'string');

  if (textSegments.length === 0) {
    return undefined;
  }
  return textSegments.join('');
}

export function getFunctionCalls(
  response: GenerateContentResponse,
): FunctionCall[] | undefined {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) {
    return undefined;
  }
  const functionCallParts = parts
    .filter((part) => !!part.functionCall)
    .map((part) => part.functionCall as FunctionCall);
  return functionCallParts.length > 0 ? functionCallParts : undefined;
}

export function getFunctionCallsFromParts(
  parts: Part[],
): FunctionCall[] | undefined {
  if (!parts) {
    return undefined;
  }
  const functionCallParts = parts
    .filter((part) => !!part.functionCall)
    .map((part) => part.functionCall as FunctionCall);
  return functionCallParts.length > 0 ? functionCallParts : undefined;
}

export function getFunctionCallsAsJson(
  response: GenerateContentResponse,
): string | undefined {
  const functionCalls = getFunctionCalls(response);
  if (!functionCalls) {
    return undefined;
  }
  return JSON.stringify(functionCalls, null, 2);
}

export function getFunctionCallsFromPartsAsJson(
  parts: Part[],
): string | undefined {
  const functionCalls = getFunctionCallsFromParts(parts);
  if (!functionCalls) {
    return undefined;
  }
  return JSON.stringify(functionCalls, null, 2);
}

export function getStructuredResponse(
  response: GenerateContentResponse,
): string | undefined {
  const textContent = getResponseText(response);
  const functionCallsJson = getFunctionCallsAsJson(response);

  if (textContent && functionCallsJson) {
    return `${textContent}\n${functionCallsJson}`;
  }
  if (textContent) {
    return textContent;
  }
  if (functionCallsJson) {
    return functionCallsJson;
  }
  return undefined;
}

export function getStructuredResponseFromParts(
  parts: Part[],
): string | undefined {
  const textContent = getResponseTextFromParts(parts);
  const functionCallsJson = getFunctionCallsFromPartsAsJson(parts);

  if (textContent && functionCallsJson) {
    return `${textContent}\n${functionCallsJson}`;
  }
  if (textContent) {
    return textContent;
  }
  if (functionCallsJson) {
    return functionCallsJson;
  }
  return undefined;
}
