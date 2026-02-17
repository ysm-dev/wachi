import readingTime from "reading-time";

export const getReadingTimeMinutes = (content: string): number => {
  const result = readingTime(content);
  return result.minutes;
};
