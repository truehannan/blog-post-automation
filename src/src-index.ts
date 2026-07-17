import type { D1Database } from '@cloudflare/workers-types';

// ============================================
// TYPE DEFINITIONS (Inline to fix import issue)
// ============================================

interface Env {
  DB: D1Database;
  GITHUB_TOKEN: string;
  UNSPLASH_ACCESS_KEY: string;
  FIRECRAWL_API_KEY: string;
  DEV_TO_API_KEY?: string;
  BLOG_IMAGES?: R2Bucket;
  ENVIRONMENT: 'production' | 'staging' | 'development';
}

interface BlogPost {
  id?: number;
  title: string;
  slug: string;
  status: string;
  excerpt: string;
  content: string;
  cover_image?: string;
  cover_image_r2_key?: string;
  meta_title?: string;
  meta_description?: string;
  published_at?: string;
  created_at?: string;
  updated_at?: string;
  sort_order?: number;
}

interface Venture {
  id: number;
  title: string;
  slug: string;
  status: string;
  excerpt: string;
  content: string;
  cover_image?: string;
  tech_stack: string;
  live_url?: string;
  github_url?: string;
  sort_order: number;
}

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface UnsplashImage {
  urls: {
    raw: string;
  };
  alt_description?: string;
  user?: {
    name: string;
  };
}

interface FirecrawlResult {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface GitHubModelsResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface UnsplashResponse {
  urls?: {
    raw: string;
  };
  alt_description?: string;
  user?: {
    name: string;
  };
}

// ============================================
// MAIN HANDLER
// ============================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log('Starting daily blog generation...');
    try {
      await generateDailyBlog(env);
      console.log('Daily blog generation completed');
    } catch (error) {
      console.error('Daily blog generation failed:', error);
    }
  },
};

// ============================================
// CORE FUNCTIONS
// ============================================

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const result = await generateDailyBlog(env);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Generation error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

async function generateDailyBlog(env: Env): Promise<object> {
  // 1. Get ventures to promote (sorted by sort_order DESC)
  const ventures = await getVenturesFromDB(env);
  const venturesToPromote = ventures
    .sort((a, b) => b.sort_order - a.sort_order)
    .slice(0, 3); // Top 3 ventures

  console.log(`Found ${ventures.length} ventures, promoting top ${venturesToPromote.length}`);

  // 2. Generate search topics based on ventures + niche interests
  const searchTopics = generateSearchTopics(venturesToPromote);
  console.log(`Generated ${searchTopics.length} search topics`);

  // 3. Search the web for fresh data
  const searchResults = await searchWeb(searchTopics, env);
  console.log(`Got ${searchResults.length} search results`);

  // 4. Generate article content using GitHub Models
  const articleData = await generateArticleWithGitHub(searchResults, venturesToPromote, env);
  console.log(`Generated article: "${articleData.title}"`);

  // 5. Get cover image from Unsplash
  const coverImage = await getUnsplashImage(articleData.title, env);
  console.log(`Got cover image from Unsplash`);

  // 6. Get inline images (up to 10)
  const inlineImages = await getMultipleUnsplashImages(articleData.content, 10, env);
  console.log(`Got ${inlineImages.length} inline images`);

  // 7. Create markdown with image placeholders
  const markdown = generateMarkdown(articleData, coverImage, inlineImages);

  // 8. Save to D1
  const blogPost = await saveBlogPostToDB(
    {
      title: articleData.title,
      slug: articleData.slug,
      excerpt: articleData.excerpt,
      content: markdown,
      cover_image: coverImage.urls.raw,
      meta_title: articleData.meta_title,
      meta_description: articleData.meta_description,
      status: 'draft',
    },
    env
  );
  console.log(`Saved blog post with ID: ${blogPost.id}`);

  // 9. Post to Dev.to
  const devtoResult = await postToDevTo(blogPost, env);
  console.log(`Dev.to result:`, devtoResult);

  return {
    success: true,
    blogPost,
    devtoUrl: devtoResult?.url,
    ventures: venturesToPromote,
  };
}

async function getVenturesFromDB(env: Env): Promise<Venture[]> {
  const db = env.DB;
  const result = await db.prepare('SELECT * FROM ventures WHERE status = ?').bind('published').all();
  return (result.results || []) as Venture[];
}

function generateSearchTopics(ventures: Venture[]): string[] {
  const baseTopics = [
    'latest AI models 2024',
    'Claude AI updates',
    'vibe coding trends',
    'tech startup news',
    'open source AI projects',
    'AI agents automation',
    'tech company stocks today',
    'programming best practices',
    'API design patterns',
    'AI finance applications',
  ];

  const ventureTopic = ventures.map((v) => `${v.title} ${v.tech_stack}`);

  return [...baseTopics.slice(0, 7), ...ventureTopic];
}

async function searchWeb(topics: string[], env: Env): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];

  for (const topic of topics.slice(0, 5)) {
    try {
      const firecrawlResults = await searchWithFirecrawl(topic, env);
      allResults.push(...firecrawlResults.slice(0, 2));
    } catch (error) {
      console.warn(`Firecrawl search failed for "${topic}":`, error);
      try {
        const fallbackResults = await searchWithFallback(topic);
        allResults.push(...fallbackResults.slice(0, 2));
      } catch (fallbackError) {
        console.warn(`Fallback search also failed for "${topic}":`, fallbackError);
      }
    }
  }

  return allResults.slice(0, 15);
}

async function searchWithFirecrawl(query: string, env: Env): Promise<SearchResult[]> {
  const response = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      limit: 5,
      scrapeOptions: {
        formats: ['markdown'],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl API error: ${response.statusText}`);
  }

  const data = (await response.json()) as { results?: FirecrawlResult[] };
  return (data.results || []).map((r: FirecrawlResult) => ({
    title: r.title || r.url || 'Unknown',
    link: r.url || '',
    snippet: r.markdown?.slice(0, 200) || r.description || '',
  }));
}

async function searchWithFallback(query: string): Promise<SearchResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}&count=5`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error('Brave search failed');
    }

    const data = (await response.json()) as { web?: BraveResult[] };
    return (data.web || []).map((result: BraveResult) => ({
      title: result.title || 'Unknown',
      link: result.url || '',
      snippet: result.description || '',
    }));
  } catch {
    return [
      {
        title: `Latest in ${query}`,
        link: 'https://news.ycombinator.com',
        snippet: `Recent developments in ${query} from major tech sources.`,
      },
    ];
  }
}

async function generateArticleWithGitHub(
  searchResults: SearchResult[],
  ventures: Venture[],
  env: Env
): Promise<{
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  meta_title: string;
  meta_description: string;
}> {
  const prompt = buildPrompt(searchResults, ventures);

  const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert tech and finance blogger. Create engaging, helpful articles that naturally incorporate mentions of specific tech ventures.
          
OUTPUT FORMAT (JSON):
{
  "title": "Article Title",
  "slug": "article-slug-kebab-case",
  "excerpt": "One sentence summary",
  "content": "Full markdown article with 1500-2000 words. Include subtle mentions of ventures.",
  "meta_title": "SEO title (60 chars max)",
  "meta_description": "SEO description (160 chars max)"
}`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('GitHub Models API error:', error);
    throw new Error(`GitHub Models failed: ${response.statusText}`);
  }

  const data = (await response.json()) as GitHubModelsResponse;
  const content = data.choices[0].message.content;

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse article JSON from model response');
  }

  return JSON.parse(jsonMatch[0]);
}

function buildPrompt(searchResults: SearchResult[], ventures: Venture[]): string {
  const searchContext = searchResults
    .map((r) => `- "${r.title}": ${r.snippet}`)
    .join('\n');

  const ventureContext = ventures
    .map((v) => `- ${v.title}: ${v.excerpt} (Tech: ${v.tech_stack})`)
    .join('\n');

  return `Create a tech/finance blog article based on these recent findings:

RECENT NEWS & TRENDS:
${searchContext}

VENTURES TO PROMOTE (subtly integrate these):
${ventureContext}

REQUIREMENTS:
- Topic: Choose from AI models, coding trends, tech company news, open source, automation, or finance
- Length: 1500-2000 words of engaging markdown
- Structure: Include H2 headings, code examples where relevant, bullet points
- Integration: Naturally weave in the ventures as solutions or examples
- Keywords: Optimize for SEO (AI, automation, tech, finance, APIs)
- Tone: Professional but approachable, like a tech blog post

Generate a complete article that would be interesting to developers and tech enthusiasts.`;
}

async function getUnsplashImage(query: string, env: Env): Promise<UnsplashImage> {
  try {
    const response = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&count=1&client_id=${env.UNSPLASH_ACCESS_KEY}`
    );

    if (!response.ok) {
      throw new Error('Unsplash API error');
    }

    const images = (await response.json()) as UnsplashResponse[];
    if (Array.isArray(images) && images[0]?.urls?.raw) {
      return images[0] as UnsplashImage;
    }

    throw new Error('No images returned');
  } catch (error) {
    console.warn('Unsplash fallback:', error);
    return {
      urls: {
        raw: 'https://images.unsplash.com/photo-1633356122544-f134324ef6db?w=1200&h=630&fit=crop',
      },
      alt_description: 'Technology',
    };
  }
}

async function getMultipleUnsplashImages(
  _content: string,
  count: number,
  env: Env
): Promise<UnsplashImage[]> {
  const topics = [
    'AI',
    'programming',
    'technology',
    'startup',
    'finance',
    'automation',
    'code',
    'open source',
    'developer',
    'innovation',
  ];

  const images: UnsplashImage[] = [];

  for (let i = 0; i < Math.min(count, topics.length); i++) {
    try {
      const response = await fetch(
        `https://api.unsplash.com/photos/random?query=${topics[i]}&count=1&client_id=${env.UNSPLASH_ACCESS_KEY}`
      );

      if (response.ok) {
        const data = (await response.json()) as UnsplashResponse;
        if (data.urls?.raw) {
          images.push(data as UnsplashImage);
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch Unsplash image for ${topics[i]}:`, error);
    }
  }

  return images;
}

function generateMarkdown(
  article: {
    title: string;
    excerpt: string;
    content: string;
    meta_title?: string;
    meta_description?: string;
  },
  coverImage: UnsplashImage,
  inlineImages: UnsplashImage[]
): string {
  const creditLine = coverImage.user
    ? `*Photo by [${coverImage.user.name}](https://unsplash.com/@${coverImage.user.name}) on Unsplash*`
    : '*Photo from Unsplash*';

  let markdown = `# ${article.title}

![Cover](${coverImage.urls.raw})
${creditLine}

> ${article.excerpt}

---

${article.content}

---

## More Resources

*Last updated: ${new Date().toISOString().split('T')[0]}*
`;

  const paragraphs = markdown.split('\n\n');
  const imageInterval = Math.max(3, Math.floor(paragraphs.length / inlineImages.length));

  inlineImages.forEach((img, idx) => {
    const insertAt = (idx + 1) * imageInterval;
    if (insertAt < paragraphs.length) {
      paragraphs.splice(insertAt, 0, `![](${img.urls.raw})`);
    }
  });

  return paragraphs.join('\n\n');
}

async function saveBlogPostToDB(post: BlogPost, env: Env): Promise<BlogPost> {
  const db = env.DB;
  const now = new Date().toISOString();
  const slug = generateSlug(post.title);

  const result = await db
    .prepare(
      `INSERT INTO blog_posts (title, slug, status, excerpt, content, cover_image, meta_title, meta_description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      post.title,
      slug,
      post.status || 'draft',
      post.excerpt,
      post.content,
      post.cover_image || '',
      post.meta_title || '',
      post.meta_description || '',
      now,
      now
    )
    .first() as BlogPost;

  return result;
}

async function postToDevTo(post: BlogPost, env: Env): Promise<{ url: string } | null> {
  if (!env.DEV_TO_API_KEY) {
    console.warn('DEV_TO_API_KEY not configured, skipping Dev.to posting');
    return null;
  }

  try {
    const response = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: {
        'api-key': env.DEV_TO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        article: {
          title: post.title,
          body_markdown: post.content,
          published: false,
          tags: ['ai', 'tech', 'automation', 'programming', 'finance'],
          canonical_url: `https://yourdomain.com/blog/${post.slug}`,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Dev.to API error: ${response.statusText}`);
    }

    const data = (await response.json()) as { url?: string };
    return data.url ? { url: data.url } : null;
  } catch (error) {
    console.error('Dev.to posting failed:', error);
    return null;
  }
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  }  link: string;
  snippet: string;
}

interface UnsplashImage {
  urls: {
    raw: string;
  };
  alt_description?: string;
  user?: {
    name: string;
  };
}

// Main handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log('Starting daily blog generation...');
    try {
      await generateDailyBlog(env);
      console.log('Daily blog generation completed');
    } catch (error) {
      console.error('Daily blog generation failed:', error);
    }
  },
};

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const result = await generateDailyBlog(env);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Generation error:', error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function generateDailyBlog(env: Env): Promise<object> {
  // 1. Get ventures to promote (sorted by sort_order DESC)
  const ventures = await getVenturesFromDB(env);
  const venturesToPromote = ventures
    .sort((a, b) => b.sort_order - a.sort_order)
    .slice(0, 3); // Top 3 ventures

  // 2. Generate search topics based on ventures + niche interests
  const searchTopics = generateSearchTopics(venturesToPromote);

  // 3. Search the web for fresh data
  const searchResults = await searchWeb(searchTopics, env);

  // 4. Generate article content using GitHub Models
  const articleData = await generateArticleWithGitHub(searchResults, venturesToPromote, env);

  // 5. Get cover image from Unsplash
  const coverImage = await getUnsplashImage(articleData.title, env);

  // 6. Get inline images (up to 10)
  const inlineImages = await getMultipleUnsplashImages(articleData.content, 10, env);

  // 7. Create markdown with image placeholders
  const markdown = generateMarkdown(articleData, coverImage, inlineImages);

  // 8. Save to D1
  const blogPost = await saveBlogPostToDB(
    {
      title: articleData.title,
      slug: articleData.slug,
      excerpt: articleData.excerpt,
      content: markdown,
      cover_image: coverImage.urls.raw,
      meta_title: articleData.meta_title,
      meta_description: articleData.meta_description,
      status: 'draft',
    },
    env
  );

  // 9. Post to Dev.to
  const devtoResult = await postToDevTo(blogPost, env);

  return {
    success: true,
    blogPost,
    devtoUrl: devtoResult?.url,
    ventures: venturesToPromote,
  };
}

async function getVenturesFromDB(env: Env): Promise<Venture[]> {
  const db = env.DB;
  const result = await db.prepare('SELECT * FROM ventures WHERE status = ?').bind('published').all();
  return (result.results || []) as Venture[];
}

function generateSearchTopics(ventures: Venture[]): string[] {
  const baseTopics = [
    'latest AI models 2024',
    'Claude AI updates',
    'vibe coding trends',
    'tech startup news',
    'open source AI projects',
    'AI agents automation',
    'tech company stocks today',
    'programming best practices',
    'API design patterns',
    'AI finance applications',
  ];

  const ventureTopic = ventures.map((v) => `${v.title} ${v.tech_stack}`);

  return [
    ...baseTopics.slice(0, 7),
    ...ventureTopic,
  ];
}

async function searchWeb(topics: string[], env: Env): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];

  // Use Firecrawl as primary search method with fallback to fetch-based approach
  for (const topic of topics.slice(0, 5)) {
    try {
      // Try Firecrawl first (more reliable for tech content)
      const firecrawlResults = await searchWithFirecrawl(topic, env);
      allResults.push(...firecrawlResults.slice(0, 2));
    } catch (error) {
      console.warn(`Firecrawl search failed for "${topic}":`, error);
      // Fallback to manual fetch method
      try {
        const fallbackResults = await searchWithFallback(topic);
        allResults.push(...fallbackResults.slice(0, 2));
      } catch (fallbackError) {
        console.warn(`Fallback search also failed for "${topic}":`, fallbackError);
      }
    }
  }

  return allResults.slice(0, 15); // Return top 15 results
}

async function searchWithFirecrawl(query: string, env: Env): Promise<SearchResult[]> {
  const response = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      limit: 5,
      scrapeOptions: {
        formats: ['markdown'],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.results?.map((r: any) => ({
    title: r.title || r.url,
    link: r.url,
    snippet: r.markdown?.slice(0, 200) || r.description || '',
  })) || [];
}

async function searchWithFallback(query: string): Promise<SearchResult[]> {
  // Fallback: Use DuckDuckGo anonymous search (no API key needed)
  // This is a workaround for when primary service fails
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}&count=5`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error('Brave search failed');
    }

    const data = await response.json();
    return data.web?.map((result: any) => ({
      title: result.title,
      link: result.url,
      snippet: result.description,
    })) || [];
  } catch {
    // Last resort: Return mock data with current date references
    // This ensures the automation doesn't fail completely
    return [
      {
        title: `Latest in ${query}`,
        link: 'https://news.ycombinator.com',
        snippet: `Recent developments in ${query} from major tech sources.`,
      },
    ];
  }
}

async function generateArticleWithGitHub(
  searchResults: SearchResult[],
  ventures: Venture[],
  env: Env
): Promise<{
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  meta_title: string;
  meta_description: string;
}> {
  const prompt = buildPrompt(searchResults, ventures);

  // Try GitHub Models (Claude 3.5 Sonnet - most capable)
  // Context: ~200k tokens available
  const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert tech and finance blogger. Create engaging, helpful articles that naturally incorporate mentions of specific tech ventures.
          
OUTPUT FORMAT (JSON):
{
  "title": "Article Title",
  "slug": "article-slug-kebab-case",
  "excerpt": "One sentence summary",
  "content": "Full markdown article with 1500-2000 words. Include subtle mentions of ventures.",
  "meta_title": "SEO title (60 chars max)",
  "meta_description": "SEO description (160 chars max)"
}`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('GitHub Models API error:', error);
    throw new Error(`GitHub Models failed: ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;

  // Parse JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse article JSON from model response');
  }

  return JSON.parse(jsonMatch[0]);
}

function buildPrompt(searchResults: SearchResult[], ventures: Venture[]): string {
  const searchContext = searchResults
    .map((r) => `- "${r.title}": ${r.snippet}`)
    .join('\n');

  const ventureContext = ventures
    .map((v) => `- ${v.title}: ${v.excerpt} (Tech: ${v.tech_stack})`)
    .join('\n');

  return `Create a tech/finance blog article based on these recent findings:

RECENT NEWS & TRENDS:
${searchContext}

VENTURES TO PROMOTE (subtly integrate these):
${ventureContext}

REQUIREMENTS:
- Topic: Choose from AI models, coding trends, tech company news, open source, automation, or finance
- Length: 1500-2000 words of engaging markdown
- Structure: Include H2 headings, code examples where relevant, bullet points
- Integration: Naturally weave in the ventures as solutions or examples
- Keywords: Optimize for SEO (AI, automation, tech, finance, APIs)
- Tone: Professional but approachable, like a tech blog post

Generate a complete article that would be interesting to developers and tech enthusiasts.`;
}

async function getUnsplashImage(
  query: string,
  env: Env
): Promise<UnsplashImage> {
  const response = await fetch(
    `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&count=1&client_id=${env.UNSPLASH_ACCESS_KEY}`
  );

  if (!response.ok) {
    // Fallback to generic tech image
    return {
      urls: {
        raw: 'https://images.unsplash.com/photo-1633356122544-f134324ef6db?w=1200&h=630&fit=crop',
      },
      alt_description: 'Technology',
    };
  }

  const images = await response.json();
  return images[0] || {
    urls: {
      raw: 'https://images.unsplash.com/photo-1633356122544-f134324ef6db?w=1200&h=630&fit=crop',
    },
  };
}

async function getMultipleUnsplashImages(
  content: string,
  count: number,
  env: Env
): Promise<UnsplashImage[]> {
  const topics = [
    'AI',
    'programming',
    'technology',
    'startup',
    'finance',
    'automation',
    'code',
    'open source',
    'developer',
    'innovation',
  ];

  const images: UnsplashImage[] = [];

  for (let i = 0; i < Math.min(count, topics.length); i++) {
    try {
      const response = await fetch(
        `https://api.unsplash.com/photos/random?query=${topics[i]}&count=1&client_id=${env.UNSPLASH_ACCESS_KEY}`
      );

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data[0]) {
          images.push(data[0]);
        } else if (data.urls) {
          images.push(data);
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch Unsplash image for ${topics[i]}:`, error);
    }
  }

  return images;
}

function generateMarkdown(
  article: {
    title: string;
    excerpt: string;
    content: string;
    meta_title?: string;
    meta_description?: string;
  },
  coverImage: UnsplashImage,
  inlineImages: UnsplashImage[]
): string {
  const creditLine = coverImage.user
    ? `*Photo by [${coverImage.user.name}](https://unsplash.com/@${coverImage.user.name}) on Unsplash*`
    : '*Photo from Unsplash*';

  let markdown = `# ${article.title}

![Cover](${coverImage.urls.raw})
${creditLine}

> ${article.excerpt}

---

${article.content}

---

## More Resources

*Last updated: ${new Date().toISOString().split('T')[0]}*
`;

  // Inject inline images at reasonable intervals
  const paragraphs = markdown.split('\n\n');
  const imageInterval = Math.max(3, Math.floor(paragraphs.length / inlineImages.length));

  inlineImages.forEach((img, idx) => {
    const insertAt = (idx + 1) * imageInterval;
    if (insertAt < paragraphs.length) {
      paragraphs.splice(
        insertAt,
        0,
        `![](${img.urls.raw})`
      );
    }
  });

  return paragraphs.join('\n\n');
}

async function saveBlogPostToDB(post: BlogPost, env: Env): Promise<BlogPost> {
  const db = env.DB;
  const now = new Date().toISOString();
  const slug = generateSlug(post.title);

  const result = await db
    .prepare(
      `INSERT INTO blog_posts (title, slug, status, excerpt, content, cover_image, meta_title, meta_description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      post.title,
      slug,
      post.status || 'draft',
      post.excerpt,
      post.content,
      post.cover_image || '',
      post.meta_title || '',
      post.meta_description || '',
      now,
      now
    )
    .first();

  return result as BlogPost;
}

async function postToDevTo(post: BlogPost, env: Env): Promise<{ url: string } | null> {
  if (!env.DEV_TO_API_KEY) {
    console.warn('DEV_TO_API_KEY not configured, skipping Dev.to posting');
    return null;
  }

  try {
    const response = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: {
        'api-key': env.DEV_TO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        article: {
          title: post.title,
          body_markdown: post.content,
          published: false, // Draft until review
          tags: ['ai', 'tech', 'automation', 'programming', 'finance'],
          canonical_url: `https://yourdomain.com/blog/${post.slug}`,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Dev.to API error: ${response.statusText}`);
    }

    const data = await response.json();
    return { url: data.url };
  } catch (error) {
    console.error('Dev.to posting failed:', error);
    return null; // Don't fail entire operation if Dev.to fails
  }
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  }
