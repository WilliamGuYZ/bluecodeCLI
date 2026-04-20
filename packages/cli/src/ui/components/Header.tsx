/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { Colors } from '../colors.js';
import { shortAsciiLogo, longAsciiLogo, tinyAsciiLogo, tinyTextLogo } from './AsciiArt.js';
import { getAsciiArtWidth } from '../utils/textUtils.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

interface HeaderProps {
  version: string;
  nightly: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  version,
  nightly,
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  let displayTitle;
  const widthOfLongLogo = getAsciiArtWidth(longAsciiLogo);
  const widthOfShortLogo = getAsciiArtWidth(shortAsciiLogo);
  const widthOfTinyLogo = getAsciiArtWidth(tinyAsciiLogo);
  if(terminalWidth >= widthOfLongLogo){
    displayTitle = longAsciiLogo;
  }else if(terminalWidth >= widthOfShortLogo){
    displayTitle = shortAsciiLogo;
  }else if(terminalWidth >= widthOfTinyLogo){
    displayTitle = tinyAsciiLogo
  }else{
    displayTitle = tinyTextLogo
  }

  const artWidth = getAsciiArtWidth(displayTitle);

  return (
    <Box
      alignItems="flex-start"
      width={artWidth}
      flexShrink={0}
      flexDirection="column"
    >
      {Colors.GradientColors ? (
        <Gradient colors={Colors.GradientColors}>
          <Text>{displayTitle}</Text>
        </Gradient>
      ) : (
        <Text>{displayTitle}</Text>
      )}
      {nightly && (
        <Box width="100%" flexDirection="row" justifyContent="flex-end">
          {Colors.GradientColors ? (
            <Gradient colors={Colors.GradientColors}>
              <Text>v{version}</Text>
            </Gradient>
          ) : (
            <Text>v{version}</Text>
          )}
        </Box>
      )}
    </Box>
  );
};
