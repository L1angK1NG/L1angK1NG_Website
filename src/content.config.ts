import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const stringList = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(String);
  }

  return [String(value)];
}, z.array(z.string()).optional());

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z
    .object({
      title: z.string(),
      description: z.string().optional(),
      date: z.coerce.date().optional(),
      updated: z.coerce.date().optional(),
      cover: z.string().optional(),
      categories: stringList,
      tags: stringList,
      keywords: stringList,
      ai: stringList,
      sticky: z.coerce.number().optional(),
      main_color: z.string().optional(),
      author: z.string().optional(),
      draft: z.boolean().optional(),
    })
    .passthrough(),
});

const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: z
    .object({
      date: z.coerce.date(),
      title: z.string().optional(),
      mood: z.string().optional(),
      tags: stringList,
      draft: z.boolean().optional(),
    })
    .passthrough(),
});

export const collections = { posts, notes };
