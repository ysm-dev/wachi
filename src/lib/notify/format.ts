export const formatNotificationBody = (link: string, title: string, summary?: string): string => {
  const base = `${link}\n\n${title}`;
  if (!summary) {
    return base;
  }

  return `${base}\n\n${summary}`;
};
