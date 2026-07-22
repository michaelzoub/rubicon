import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPublishedArticleRepository } from "../repositories/in-memory.js";
import type { PublishedArticleRepository } from "../repositories/types.js";
import { routeArticleSections } from "./section-router.js";

function repository() {
  return new InMemoryPublishedArticleRepository({ articles: [{
    id: "selected", creatorId: "creator", creatorUsername: "writer", title: "Research",
    author: "Writer", state: "live", revision: 7, pricePerWordAtomic: 1n,
    body: "# Overview\nPublic opening.\n## Economic effects\nPRIVATE_NEURAL_SIGNAL appears only here.\n## Methods\nProcedure.",
  }] });
}

test("semantic routing finds body-derived relevance and passes article/revision scope", async () => {
  const repo = repository();
  const article = (await repo.getPublishedArticle("selected"))!;
  const economic = article.sections.find((section) => section.heading === "Economic effects")!;
  let received: Parameters<NonNullable<PublishedArticleRepository["searchSections"]>>[0] | undefined;
  const scoped = repo as PublishedArticleRepository;
  scoped.searchSections = async (input) => {
    received = input;
    return [{ articleId: "selected", sectionId: economic.sectionId, revision: 7, similarity: 0.91 }];
  };
  const route = await routeArticleSections({ article, query: "labor displacement", repo: scoped, embedder: async () => [1] });
  assert.equal(route.mode, "semantic");
  assert.equal(route.candidates[0]?.sectionId, economic.sectionId);
  assert.equal(received?.articleId, "selected");
  assert.equal(received?.revision, 7);
});

test("stale, cross-article, and hallucinated IDs are rejected with heading fallback", async () => {
  const repo = repository() as PublishedArticleRepository;
  const article = (await repo.getPublishedArticle("selected"))!;
  const methods = article.sections.find((section) => section.heading === "Methods")!;
  repo.searchSections = async () => [
    { articleId: "other", sectionId: methods.sectionId, revision: 7, similarity: 1 },
    { articleId: "selected", sectionId: methods.sectionId, revision: 6, similarity: 1 },
    { articleId: "selected", sectionId: "hallucinated", revision: 7, similarity: 1 },
  ];
  const route = await routeArticleSections({ article, query: "methods", repo, embedder: async () => [1] });
  assert.equal(route.mode, "lexical");
  assert.equal(route.candidates[0]?.sectionId, methods.sectionId);
});
