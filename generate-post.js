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
  
  return result.result;
}

// Helper to prune old posts and keep the database size capped at 500 rows
async function pruneOldBlogPosts() {
  console.log("Checking blog_posts table limit...");
  
  const countResult = await queryD1("SELECT COUNT(*) as total FROM blog_posts");
  const totalPosts = countResult[0]?.results[0]?.total || 0;
  
  console.log(`Current blog post count: ${totalPosts}`);
  
  if (totalPosts > 500) {
    const overflowCount = totalPosts - 500;
    console.log(`Pruning limit exceeded! Removing the oldest ${overflowCount} post(s)...`);
    
    const pruneSQL = `
      DELETE FROM blog_posts 
      WHERE id IN (
        SELECT id FROM blog_posts 
        ORDER BY created_at ASC 
        LIMIT ${overflowCount}
      );
    `;
    
    await queryD1(pruneSQL);
    console.log("Pruning completed successfully.");
  } else {
    console.log("Blog post count is within limits. No pruning needed.");
  }
}

// 1. Fetch search data using Firecrawl (With Dynamic Randomized Queries)
async function fetchTrendingTechNews() {
  // Pool of radically different technical focus areas
  const queryPool = [
    "trending open source github repositories developer tools projects 2026",
    "latest breakthrough AI models LLM engineering advancements 2026",
    "tech company stocks market analysis nvidia apple microsoft updates 2026",
    "serverless framework edge computing cloudflare architecture innovation 2026",
    "vibe coding natural language programming software engineering future 2026",
    "indie hacker micro saas building scaling tech startups 2026",
    "database design technology distributed systems sqlite d1 planetscale 2026"
  ];

  // Pick a random query angle to change the news feed completely on each run
  const randomQuery = queryPool[Math.floor(Math.random() * queryPool.length)];
  console.log(`Selected dynamic news angle: "${randomQuery}"`);
  console.log("Searching the web via Firecrawl...");
  
  const response = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: randomQuery,
      limit: 5,
      scrapeOptions: {
        formats: ["markdown"],
        onlyMainContent: true
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firecrawl Search Failed: ${response.status} - ${errorText}`);
  }

  const payload = await response.json();
  
  let resultsArray = [];
  if (payload && payload.data) {
    if (Array.isArray(payload.data.web)) {
      resultsArray = payload.data.web;
    } else if (Array.isArray(payload.data)) {
      resultsArray = payload.data;
    }
  } else if (payload && Array.isArray(payload.results)) {
    resultsArray = payload.results;
  }

  if (resultsArray.length === 0) {
    console.warn("Firecrawl returned empty search results. Using fallback context.");
    return `Theme context: ${randomQuery}`;
  }

  return resultsArray.map(item => {
    const markdownContent = item.markdown || item.content || "";
    return `Source: ${item.url || 'Unknown'}\nTitle: ${item.title || 'No Title'}\nContent: ${markdownContent.slice(0, 1500)}`;
  }).join("\n\n---\n\n");
}

// 2. Fetch a single unique image from Unsplash matching a custom query string
async function fetchSingleUnsplashImage(query) {
  try {
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }
    );

    if (!response.ok) throw new Error("Unsplash rate limit or failure");

    const data = await response.json();
    if (data.results && data.results.length > 0) {
      const randomIndex = Math.floor(Math.random() * Math.min(data.results.length, 3));
      return `${data.results[randomIndex].urls.raw}&auto=format&fit=crop&w=1200&q=80`;
    }
  } catch (err) {
    console.warn(`Unsplash match failed for "${query}". Using stable default asset.`);
  }

  return `https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80`;
}

// 3. Generate blog markdown setup and image keywords using GitHub Models (GPT-4o API)
async function generateBlogPostStructure(newsContext, targetVenture) {
  console.log("Generating tailored blog metadata & image keywords via GitHub Models...");
  
  const systemPrompt = `You are an elite software engineer, tech journalist, and startup founder. 
Your goal is to write an extremely high-quality, engaging, and professional technical blog post targeting niches like Open Source, AI engineering, Serverless development, Tech Stocks, or Developer Careers.
Under-the-hood, you MUST organically promote the user's venture: "${targetVenture.title}" (${targetVenture.live_url || 'https://github.com'}). 
Seamlessly integrate the venture as a direct, perfect solution to the exact challenges described in the tech news context provided.`;

  const userPrompt = `
Here is the latest internet context on trending tech & finance:
${newsContext}

Here is the Venture you need to promote:
- Name: ${targetVenture.title}
- Description: ${targetVenture.excerpt}
- Tech Stack: ${targetVenture.tech_stack}
- URL: ${targetVenture.live_url || targetVenture.github_url}

Generate a strict JSON object containing:
{
  "title": "A highly catchy clickbait title relevant to the news",
  "slug": "url-friendly-slug",
  "excerpt": "A short engaging meta description",
  "content": "Full markdown article content text. Leave 10 distinct standalone token placeholders exactly formatted as [IMAGE_PLACEHOLDER_1], [IMAGE_PLACEHOLDER_2] ... up to [IMAGE_PLACEHOLDER_10] spread out cleanly between paragraphs or beneath subheadings where an image conceptually fits. Do not include or write any markdown imagery formatting for the cover image inside this text block.",
  "image_queries": [
    "highly specific 3-4 word keyword match for a stunning article header layout image matching the topic narrative",
    "query text for placeholder 1",
    "query text for placeholder 2",
    "query text for placeholder 3",
    "query text for placeholder 4",
    "query text for placeholder 5",
    "query text for placeholder 6",
    "query text for placeholder 7",
    "query text for placeholder 8",
    "query text for placeholder 9",
    "query text for placeholder 10"
  ]
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
      temperature: 0.8
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub Models Inference failed: ${await response.text()}`);
  }

  const result = await response.json();
  return JSON.parse(result.choices[0].message.content);
}

// 4. Publish to Dev.to with proper main_image mapping
async function publishToDevTo(blog, coverImageUrl) {
  console.log("Publishing to Dev.to with native cover image...");
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
        main_image: coverImageUrl,
        tags: ["tech", "ai", "programming", "opensource"],
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
    console.log("Reading Ventures database table from D1 API...");
    const d1Result = await queryD1("SELECT * FROM ventures WHERE status = 'published' ORDER BY sort_order ASC LIMIT 1");

    let targetVenture = null;
    if (d1Result && d1Result[0] && d1Result[0].results && d1Result[0].results.length > 0) {
      targetVenture = d1Result[0].results[0];
    } else {
      console.log("No 'published' ventures found in results. Attempting fallback...");
      const fallbackResult = await queryD1("SELECT * FROM ventures ORDER BY sort_order ASC LIMIT 1");
      if (fallbackResult && fallbackResult[0] && fallbackResult[0].results && fallbackResult[0].results.length > 0) {
        targetVenture = fallbackResult[0].results[0];
      }
    }

    if (!targetVenture) {
      targetVenture = {
        title: "My Tech Studio",
        excerpt: "Building high-performance MVPs, decentralized serverless systems, and minimal premium digital designs.",
        tech_stack: "['Next.js', 'React', 'Cloudflare Workers', 'D1', 'R2']",
        live_url: "https://github.com",
        github_url: "https://github.com"
      };
    }

    console.log(`Successfully targeted venture for promotion: "${targetVenture.title}"`);

    // A. Collect dynamically randomized search facts and trigger AI blueprint mapping
    const newsContext = await fetchTrendingTechNews();
    const generatedBlog = await generateBlogPostStructure(newsContext, targetVenture);

    // B. Resolve AI contextual search terms into live Unsplash imagery array dynamically
    const images = [];
    const queries = generatedBlog.image_queries || Array(11).fill("technology conceptual workspace");
    
    console.log("Resolving AI keyword queries against Unsplash Engine...");
    for (let i = 0; i < 11; i++) {
      const imgUrl = await fetchSingleUnsplashImage(queries[i]);
      images.push(imgUrl);
    }

    const coverImage = images[0];

    // C. Swap inline placeholders within the text template with clean Markdown image declarations
    for (let i = 1; i <= 10; i++) {
      const placeholderToken = `[IMAGE_PLACEHOLDER_${i}]`;
      const markdownFormat = `![${generatedBlog.title} inline context visual](${images[i]})`;
      generatedBlog.content = generatedBlog.content.replace(placeholderToken, markdownFormat);
    }

    // D. Save local markdown backup inside the runner env
    if (!fs.existsSync('./posts')) {
      fs.mkdirSync('./posts');
    }
    fs.writeFileSync(`./posts/${generatedBlog.slug}.md`, generatedBlog.content);

    // E. Write directly back to your D1 DB blog_posts
    console.log("Saving generated post back to Cloudflare D1...");
    const insertSQL = `
      INSERT INTO blog_posts (title, slug, status, excerpt, content, cover_image, meta_title, meta_description, published_at)
      VALUES (
        '${generatedBlog.title.replace(/'/g, "''")}',
        '${generatedBlog.slug}',
        'published',
        '${generatedBlog.excerpt.replace(/'/g, "''")}',
        '${generatedBlog.content.replace(/'/g, "''")}',
        '${coverImage}',
        '${generatedBlog.title.replace(/'/g, "''")}',
        '${generatedBlog.excerpt.replace(/'/g, "''")}',
        datetime('now')
      );
    `;
    await queryD1(insertSQL);

    // F. Prune database overflow entries to cap sizing limits reliably at 500 records
    try {
      await pruneOldBlogPosts();
    } catch (pruneError) {
      console.error("Non-blocking pruning error:", pruneError);
    }

    // G. Cross-post automatically to Dev.to passing along the correct header cover image URL asset 
    await publishToDevTo(generatedBlog, coverImage);

    console.log("Automation task successfully executed!");

  } catch (error) {
    console.error("Pipeline failure:", error);
    process.exit(1);
  }
}

main();
