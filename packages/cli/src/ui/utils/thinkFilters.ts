/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const END_THINK_TAG = '</think>';

class ThinkFilter {
  private isEndThink: boolean = false
  private static instance: ThinkFilter | undefined

  /**
   * getInstance
   */
  static getInstance(): ThinkFilter {
    if (!this.instance) {
      this.instance = new ThinkFilter()
    }

    return this.instance
  }

  /**
   * resetEndThinkState
   */
  resetEndThinkState() {
    this.isEndThink = false
  }

  /**
   * contentFilter
   */
  contentFilter(content: string) {
    if (this.isEndThink) {
      return content
    }

    const endTagIndex = content.indexOf(END_THINK_TAG)

    if (endTagIndex < 0) {
      return ''
    }

    this.isEndThink = true
    return content.slice(endTagIndex + END_THINK_TAG.length).replace(/^(?:\r\n|\n)+/, '')
  }
}

/**
 * Strip <think>...</think> block from a complete string.
 * For use on already-complete stored content (e.g. session resume),
 * unlike the stateful streaming filter above.
 */
export function stripThinkContent(content: string): string {
  const endTagIndex = content.indexOf(END_THINK_TAG);
  if (endTagIndex < 0) {
    return content;
  }
  return content.slice(endTagIndex + END_THINK_TAG.length).replace(/^(?:\r\n|\n)+/, '');
}

export default ThinkFilter.getInstance()