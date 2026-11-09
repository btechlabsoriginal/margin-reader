import { describe, expect, it } from 'vitest';
import { extractArticle } from '../src/fetch.js';

const story = `
<html><head>
<title>An example · Publishing House</title>
<meta property="og:title" content="A Carefully Kept Story">
<meta name="author" content="Dana Okeke">
<meta property="article:published_time" content="2026-09-21T08:00:00Z">
</head><body>
<nav><a href="/">Home</a><a href="/browse">Browse</a></nav>
<div class="recommended-articles"><p>Other links and recommendations and suggested things to click through next.</p></div>
<article class="story-content">
<h1>A Carefully Kept Story</h1>
<p>One thoughtful paragraph about keeping a personal library, and why attention deserves a little more care than we usually give it. Every sentence is written for readers rather than for search engines.</p>
<p>Another long paragraph considers the quiet discipline of reading, observing, and remembering ideas. It goes on for a while so that the extractor can identify the article as the central cluster of prose.</p>
<p>The final paragraph explores returning to a text days later, when its argument finally begins to make sense. This is the part that will stay on the page after the noisy furniture is removed.</p>
<script>window.tracker = 'should not be here'</script>
<a href="javascript:alert(1)">unsafe link</a>
</article>
<footer>Share me everywhere</footer>
</body></html>`;

describe('article extraction', () => {
  it('keeps the strongest prose cluster and its metadata', () => {
    const result = extractArticle(story, 'https://www.example.com/story');
    expect(result.title).toBe('A Carefully Kept Story');
    expect(result.author).toBe('Dana Okeke');
    expect(result.publishedAt).toBe('2026-09-21T08:00:00.000Z');
    expect(result.site).toBe('example.com');
    expect(result.contentText).toContain('quiet discipline of reading');
    expect(result.contentText).not.toContain('Share me everywhere');
    expect(result.contentHtml).not.toContain('script');
    expect(result.contentHtml).not.toContain('javascript:');
    expect(result.contentHtml).not.toContain('recommended-articles');
  });

  it('rejects pages that cannot yield readable content', () => {
    expect(() => extractArticle('<html><body><nav>Links</nav><p>Hi</p></body></html>', 'https://example.com'))
      .toThrow('Could not extract enough readable text');
  });
});
