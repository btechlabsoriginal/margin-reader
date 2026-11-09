export type Status = 'pending' | 'processing' | 'ready' | 'failed';

export type Article = {
  id: number;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  site: string;
  excerpt: string;
  status: Status;
  archived: boolean;
  error: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  snippet?: string;
  snippetOffsets?: Array<[number, number]>;
  titleOffsets?: Array<[number, number]>;
};

export type FullArticle = Article & { contentHtml: string; contentText: string };
export type Collection = { total: number; items: Article[] };
export type TagsResponse = { items: Array<{ name: string; count: number }> };
