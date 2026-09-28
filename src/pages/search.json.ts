import {
  formatDate,
  getPostCategory,
  getPostExcerpt,
  getPostPath,
  getPostTags,
  sortPosts,
} from '../lib/posts';
import { getPublishedPosts } from '../lib/posts';

export async function GET() {
  const posts = sortPosts(await getPublishedPosts());
  const items = posts.map((post) => {
    const category = getPostCategory(post);
    const tags = getPostTags(post);
    const keywords = post.data.keywords ?? [];
    // Real excerpt only — the generic filler would both clutter result rows
    // and make every post match queries like "笔记".
    const description = getPostExcerpt(post) ?? '';

    return {
      title: post.data.title,
      description,
      url: getPostPath(post),
      date: post.data.date ? formatDate(post.data.date) : '',
      category: category ?? '',
      tags,
      keywords,
      text: [
        post.data.title,
        description,
        category,
        ...tags,
        ...keywords,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    };
  });

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
