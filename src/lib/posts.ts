import type { CollectionEntry } from 'astro:content';
import { getCollection } from 'astro:content';
import siteConfig from '../data/site.config.json';

export type BlogPost = CollectionEntry<'posts'>;

export const site = {
  name: siteConfig.siteName,
  description: siteConfig.siteDescription,
  url: import.meta.env.SITE_URL ?? 'https://example.com',
  author: siteConfig.siteAuthor,
};

// 仅返回已发布内容的访问器。草稿由管理端撰写，但绝不会构建进公开站点，
// 因此每个页面和 feed 都通过这些函数过滤。
export const getPublishedPosts = async (): Promise<BlogPost[]> =>
  (await getCollection('posts')).filter((post) => !post.data.draft);

export const getPublishedNotes = async () =>
  (await getCollection('notes')).filter((note) => !note.data.draft);

const getTime = (date?: Date) => date?.getTime() ?? 0;

export const sortPosts = (posts: BlogPost[]) =>
  [...posts].sort((a, b) => {
    const stickyDiff = (b.data.sticky ?? 0) - (a.data.sticky ?? 0);

    if (stickyDiff !== 0) {
      return stickyDiff;
    }

    const dateDiff = getTime(b.data.date) - getTime(a.data.date);

    if (dateDiff !== 0) {
      return dateDiff;
    }

    return a.data.title.localeCompare(b.data.title, 'zh-CN');
  });

export const sortPostsByDate = (posts: BlogPost[]) =>
  [...posts].sort((a, b) => {
    const dateDiff = getTime(b.data.date) - getTime(a.data.date);

    if (dateDiff !== 0) {
      return dateDiff;
    }

    return a.data.title.localeCompare(b.data.title, 'zh-CN');
  });

export const formatDate = (date?: Date) => {
  if (!date) {
    return '';
  }

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

export const getPostDescription = (post: BlogPost) =>
  post.data.description ?? post.data.ai?.[0] ?? '技术记录与实践笔记。';

// 只用真实摘要 —— 没有时返回 undefined 而非通用占位文案，
// 这样列表行可以直接省略这一行，而不是在每篇旧文章下重复样板文字。
export const getPostExcerpt = (post: BlogPost) =>
  post.data.description ?? post.data.ai?.[0];

export const getPostCategory = (post: BlogPost) => post.data.categories?.[0];

export const getPostTags = (post: BlogPost) => post.data.tags ?? [];

export const getPostCover = (post: BlogPost) => post.data.cover;

export const getPostPath = (post: BlogPost) => `/posts/${post.id}/`;

export const absoluteUrl = (path: string) => new URL(path, site.url).toString();

export const getPostUrl = (post: BlogPost) => absoluteUrl(getPostPath(post));

export const getPostUpdatedDate = (post: BlogPost) =>
  post.data.updated ?? post.data.date;

export const getReadingMinutes = (post: BlogPost) => {
  const body = (post as BlogPost & { body?: string }).body ?? '';
  const cjkChars = body.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const words = body
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const readingUnits = cjkChars + words;

  return Math.max(1, Math.ceil(readingUnits / 350));
};

export const getAdjacentPosts = (posts: BlogPost[], currentPost: BlogPost) => {
  const orderedPosts = sortPostsByDate(posts);
  const index = orderedPosts.findIndex((post) => post.id === currentPost.id);

  return {
    newer: index > 0 ? orderedPosts[index - 1] : undefined,
    older:
      index >= 0 && index < orderedPosts.length - 1
        ? orderedPosts[index + 1]
        : undefined,
  };
};

export const getRelatedPosts = (
  posts: BlogPost[],
  currentPost: BlogPost,
  limit = 3,
) => {
  const currentCategory = getPostCategory(currentPost);
  const currentTags = new Set(getPostTags(currentPost));

  return sortPostsByDate(posts)
    .filter((post) => post.id !== currentPost.id)
    .map((post) => {
      const sharedTags = getPostTags(post).filter((tag) => currentTags.has(tag));
      const sameCategory =
        currentCategory && getPostCategory(post) === currentCategory ? 1 : 0;

      return {
        post,
        score: sameCategory * 3 + sharedTags.length,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.post);
};

const countItems = (items: string[]) =>
  items.reduce<Map<string, number>>((counts, item) => {
    const name = String(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  }, new Map());

const mapToSortedTerms = (counts: Map<string, number>) =>
  [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));

export const getCategories = (posts: BlogPost[]) =>
  mapToSortedTerms(
    countItems(posts.flatMap((post) => post.data.categories ?? [])),
  );

export const getTags = (posts: BlogPost[]) =>
  mapToSortedTerms(countItems(posts.flatMap((post) => getPostTags(post))));

export const getCategoryPath = (category: string) =>
  `/categories/${encodeURIComponent(category)}/`;

export const getTagPath = (tag: string) =>
  `/tags/${encodeURIComponent(tag)}/`;

export const getPostsByCategory = (posts: BlogPost[], category: string) =>
  sortPosts(posts).filter((post) => post.data.categories?.includes(category));

export const getPostsByTag = (posts: BlogPost[], tag: string) =>
  sortPosts(posts).filter((post) => getPostTags(post).includes(tag));

export const groupPostsByYear = (posts: BlogPost[]) => {
  const groups = new Map<string, BlogPost[]>();

  for (const post of sortPosts(posts)) {
    const year = post.data.date?.getFullYear().toString() ?? '未注明日期';
    groups.set(year, [...(groups.get(year) ?? []), post]);
  }

  return [...groups.entries()].map(([year, yearPosts]) => ({
    year,
    posts: yearPosts,
  }));
};
