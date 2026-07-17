import fs from 'fs';

// Helper to query Cloudflare D1 via official REST API directly
async function queryD1(sql) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DATABASE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sql })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`D1 API Query Failed: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`D1 API Query Error: ${JSON.stringify(result.errors)}`);
  }
  
  return result.result; // Returns query results array
}

// 1. Fetch search data using Firecrawl (Search API)
async function fetchTrendingTechNews() {
  console.log("Searching the web for latest tech and finance trends via Firecrawl...");
  const query = "latest breakthrough AI models vibe coding tech company stocks open source news 2026";
  
  const response = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: query,
      limit: 5,
      pageOptions: { onlyMainContent: true }
    })
  });

  if (!response.ok) {
    throw new Error(`Firecrawl Search Failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data.map(item => `Source: ${item.url}\nTitle: ${item.title}\nContent: ${item.markdown.slice(0, 1500)}`).join("\n\n---\n\n");
}

// 2. Fetch Unsplash images (Direct Raw URL)
async function fetchUnsplashImages(topic, count = 11) {
  console.log(`Fetching ${count} raw images from Unsplash for topic: ${topic}...`);
  const response = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(topic)}&per_page=${count}&orientation=landscape`,
    {
      headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
    }
  );

  if (!response.ok) {
    console.warn("Unsplash API failed, utilizing secure generic fallbacks.");
    return Array(count).fill("https://images.unsplash.com/photo-1518770660439-4636190af475");
  }

  const data = await response.json();
  return data.results.map(img => img.urls.raw);
}

// 3. Generate blog markdown using GitHub Models (GPT-4o API)
async function generateBlogPost(newsContext, targetVenture, images) {
  console.log("Generating blog post via GitHub Models...");
  
  const systemPrompt = `You are an elite software engineer, tech journalist, and startup founder. 
Your goal is to write an extremely high-quality, engaging, and professional technical blog post targeting niches like AI, Vibe Coding, Tech Stocks, or Developer Careers.
Under-the-hood, you MUST organically promote the user's venture: "${targetVenture.title}" (${targetVenture.live_url || 'https://github.com'}). 
Seamlessly integrate the venture as a direct, perfect solution to the exact challenges described in the tech news.`;

  const userPrompt = `
Here is the latest internet context on trending tech & finance:
${newsContext}

Here is the Venture you need to promote:
- Name: ${targetVenture.title}
- Description: ${targetVenture.excerpt}
- Tech Stack: ${targetVenture.tech_stack}
- URL: ${targetVenture.live_url || targetVenture.github_url}

Images to embed into the post (use these EXACT markdown image raw URLs inside markdown syntax like ![]() ):
- Cover Image: ${images[0]}
- Inline Image 1: ${images[1]}
- Inline Image 2: ${images[2]}
- Inline Image 3: ${images[3]}
- Inline Image 4: ${images[4]}
- Inline Image 5: ${images[5]}
- Inline Image 6: ${images[6]}
- Inline Image 7: ${images[7]}
- Inline Image 8: ${images[8]}
- Inline Image 9: ${images[9]}
- Inline Image 10: ${images[10]}

Generate a strict JSON object containing:
{
  "title": "A highly catchy clickbait title",
  "slug": "url-friendly-slug",
  "excerpt": "A short engaging meta description",
  "content": "Full markdown article content containing the 10 inline images scattered naturally inside paragraphs and headings. Make sure to promote the venture seamlessly near the middle or conclusion."
}`;

  const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_MODELS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub Models Inference failed: ${await response.text()}`);
  }

  const result = await response.json();
  return JSON.parse(result.choices[0].message.content);
}

// 4. Publish to Dev.to
async function publishToDevTo(blog) {
  console.log("Publishing to Dev.to...");
  const response = await fetch("https://dev.to/api/articles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.DEV_TO_API_KEY
    },
    body: JSON.stringify({
      article: {
        title: blog.title,
        published: true,
        body_markdown: blog.content,
        tags: ["tech", "ai", "programming", "finance"],
        description: blog.excerpt
      }
    })
  });

  if (response.ok) {
    const data = await response.json();
    console.log(`Successfully cross-posted to Dev.to! URL: ${data.url}`);
  } else {
    console.error("Failed to post to Dev.to:", await response.text());
  }
}

// Main Orchestrator Execution
async function main() {
  try {
    // A. Fetch venture to promote, prioritized by 'sort_order' ascending (Lowest sort_order has highest priority)
    console.log("Reading Ventures database table from D1 API...");
    const d1Result = await queryD1("SELECT * FROM ventures WHERE status = 'published' ORDER BY sort_order ASC LIMIT 1");
    
    if (!d1Result || d1Result.length === 0 || !d1Result[0].results || d1Result[0].results.length === 0) {
      throw new Error("No published ventures found to promote. Please insert at least one active venture into D1.");
    }
    const targetVenture = d1Result[0].results[0];
    console.log(`Targeting venture for promotion: ${targetVenture.title}`);

    // B. Collect search facts
    const newsContext = await fetchTrendingTechNews();

    // C. Get high-quality images from Unsplash (1 cover + 10 content)
    const images = await fetchUnsplashImages("technology development software business finance", 11);

    // D. Request article creation from GitHub Models LLM
    const generatedBlog = await generateBlogPost(newsContext, targetVenture, images);

    // E. Save local markdown backup inside the runner env (optional directory creation)
    if (!fs.existsSync('./posts')) {
      fs.mkdirSync('./posts');
    }
    fs.writeFileSync(`./posts/${generatedBlog.slug}.md`, generatedBlog.content);

    // F. Write directly back to your D1 DB blog_posts
    console.log("Saving generated post back to Cloudflare D1...");
    const insertSQL = `
      INSERT INTO blog_posts (title, slug, status, excerpt, content, cover_image, meta_title, meta_description, published_at)
      VALUES (
        '${generatedBlog.title.replace(/'/g, "''")}',
        '${generatedBlog.slug}',
        'published',
        '${generatedBlog.excerpt.replace(/'/g, "''")}',
        '${generatedBlog.content.replace(/'/g, "''")}',
        '${images[0]}',
        '${generatedBlog.title.replace(/'/g, "''")}',
        '${generatedBlog.excerpt.replace(/'/g, "''")}',
        datetime('now')
      );
    `;
    await queryD1(insertSQL);

    // G. Cross-post automatically to Dev.to
    await publishToDevTo(generatedBlog);

    console.log("Automation task successfully executed!");

  } catch (error) {
    console.error("Pipeline failure:", error);
    process.exit(1);
  }
}

main();
