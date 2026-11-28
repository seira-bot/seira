/** What the person asked the theme maker for. The picture's address and colours stay in this window. */
export interface AiThemeRequest {
  words?: string;
  brandColour?: string;
  picture?: { url: string; colours: string[] };
}

export function requestBody(request: AiThemeRequest): { words?: string; brandColour?: string; pictureColours?: string[] } {
  return {
    ...(request.words ? { words: request.words } : {}),
    ...(request.brandColour ? { brandColour: request.brandColour } : {}),
    ...(request.picture ? { pictureColours: request.picture.colours } : {}),
  };
}
