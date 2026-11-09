export type ArticleStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface ArticleRow {
  id: number;
  url: string;
  title: string;
  author: string | null;
  published_at: string | null;
  site: string;
  excerpt: string;
  content_html: string;
  content_text: string;
  status: ArticleStatus;
  archived: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ArticleSummary {
  id: number;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  site: string;
  excerpt: string;
  status: ArticleStatus;
  archived: boolean;
  error: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExtractedArticle {
  title: string;
  author: string | null;
  publishedAt: string | null;
  site: string;
  excerpt: string;
  contentHtml: string;
  contentText: string;
}

export interface SearchHit extends ArticleSummary {
  snippet: string;
  snippetOffsets: Array<[number, number]>;
  titleOffsets: Array<[number, number]>;
  score: number;
}
