import type { CleanupRecipe, TranscriptParagraph } from "./types.js";

export function applyCleanupRecipes(
  paragraphs: readonly TranscriptParagraph[],
  recipes: readonly CleanupRecipe[],
): readonly TranscriptParagraph[] {
  return paragraphs
    .map((paragraph) => ({
      ...paragraph,
      text: recipes.reduce(
        (text, recipe) => applyRecipe(text, recipe),
        paragraph.text,
      ),
    }))
    .filter((paragraph) => paragraph.text.length > 0);
}

function applyRecipe(text: string, recipe: CleanupRecipe): string {
  switch (recipe.type) {
    case "normalize_whitespace":
      return text.trim().replace(/\s+/gu, " ");
    case "remove_repeated_line":
      return text
        .split("\n")
        .filter((line) => line.trim() !== recipe.exactLine)
        .join("\n")
        .trim();
    case "replace":
      if (recipe.search.length === 0) return text;
      return text.split(recipe.search).join(recipe.replacement);
  }
}
