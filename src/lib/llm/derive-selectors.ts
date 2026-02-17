import { load } from "cheerio";
import type { CssSelectors } from "../css/extract.ts";

const classSelector = (tagName: string, className: string | undefined): string => {
  if (!className) {
    return tagName;
  }
  const firstClass = className
    .split(/\s+/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  if (!firstClass) {
    return tagName;
  }

  return `${tagName}.${firstClass}`;
};

const pickCandidate = (html: string): string => {
  const $ = load(html);

  if ($("tr.athing").length >= 3) {
    return "tr.athing";
  }
  if ($("article").length >= 3) {
    return "article";
  }
  if ($("li").length >= 3) {
    return "li";
  }

  const classCounts = new Map<string, number>();
  $("div[class],section[class]").each((_index, element) => {
    const tagName = element.tagName.toLowerCase();
    const value = classSelector(tagName, $(element).attr("class"));
    classCounts.set(value, (classCounts.get(value) ?? 0) + 1);
  });

  let winner = "div";
  let winnerCount = 0;
  for (const [selector, count] of classCounts.entries()) {
    if (count > winnerCount) {
      winner = selector;
      winnerCount = count;
    }
  }

  return winnerCount >= 3 ? winner : "a";
};

export const deriveSelectorsFromHtml = (html: string): CssSelectors => {
  const itemSelector = pickCandidate(html);
  const $ = load(html);
  const firstItem = $(itemSelector).first();
  const anchor = firstItem.find("a[href]").first();

  if (anchor.length > 0) {
    const className = anchor.attr("class");
    const scopedSelector = classSelector("a", className);
    return {
      item_selector: itemSelector,
      title_selector: scopedSelector,
      link_selector: scopedSelector,
    };
  }

  return {
    item_selector: itemSelector,
    title_selector: "a",
    link_selector: "a",
  };
};
