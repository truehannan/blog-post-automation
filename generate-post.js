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

// Helper to prune old posts and keep the database size capped at 500 rows
async function pruneOldBlogPosts() {
  console.log("Checking blog_posts table limit...");
  
  // 1. Get the current count of blog posts
  const countResult = await queryD1("SELECT COUNT(*) as total FROM blog_posts");
  const totalPosts = countResult[0]?.results[0]?.total || 0;
  
  console.log(`Current blog post count: ${totalPosts}`);
  
  if (totalPosts > 500) {
    const overflowCount = totalPosts - 500;
    console.log(`Pruning limit exceeded! Removing the oldest ${overflowCount} post(s)...`);
    
    // 2. Delete the oldest entries by ordering by created_at ascending
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

// 1. Fetch search data using Firecrawl (Robust V2 search extraction)
async function fetchTrendingTechNews() {
  console.log("Searching the web for latest tech and finance trends via Firecrawl...");
  const query = "latest breakthrough AI models vibe coding tech company stocks open source news 2026";
  
  const response = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: query,
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
  
  // Cleanly extract the array of web results
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
    console.warn("Firecrawl returned empty search results or unexpected format. Using mock fallback search context.");
    return "Theme: AI agents development, Node.js serverless architectures, Cloudflare development tools, and stock market momentum in 2026.";
  }

  return resultsArray.map(item => {
    const markdownContent = item.markdown || item.content || "";
    return `Source: ${item.url || 'Unknown'}\nTitle: ${item.title || 'No Title'}\nContent: ${markdownContent.slice(0, 1500)}`;
  }).join("\n\n---\n\n");
}

// 2. Fetch Unsplash images with optimized web-dimensions
async function fetchUnsplashImages(topic, count = 11) {
  console.log(`Fetching ${count} images from Unsplash for topic: ${topic}...`);
  const response = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(topic)}&per_page=${count}&orientation=landscape`,
    {
      headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
    }
  );

  if (!response.ok) {
    console.warn("Unsplash API failed, utilizing secure generic fallbacks.");
    return Array(count).fill("https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80");
  }

  const data = await response.json();
  return data.results.map(img => `${img.urls.raw}&auto=format&fit=crop&w=1200&q=80`);
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

Images to embed into the post:
- NOT FOR BODY (DO NOT place this in markdown body, it will be added as metadata): ${images[0]}
- Inline Image 1 (place in markdown): ${images[1]}
- Inline Image 2 (place in markdown): ${images[2]}
- Inline Image 3 (place in markdown): ${images[3]}
- Inline Image 4 (place in markdown): ${images[4]}
- Inline Image 5 (place in markdown): ${images[5]}
- Inline Image 6 (place in markdown): ${images[6]}
- Inline Image 7 (place in markdown): ${images[7]}
- Inline Image 8 (place in markdown): ${images[8]}
- Inline Image 9 (place in markdown): ${images[9]}
- Inline Image 10 (place in markdown): ${images[10]}

Generate a strict JSON object containing:
{
  "title": "A highly catchy clickbait title",
  "slug": "url-friendly-slug",
  "excerpt": "A short engaging meta description",
  "content": "Full markdown article content containing ONLY the 10 inline images scattered naturally inside paragraphs and headings. DO NOT render or include the cover image inside this markdown body."
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
        main_image: coverImageUrl, // Correct Dev.to API field for native cover images
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
    console.log("Reading Ventures database table from D1 API...");
    
    const d1Result = await queryD1("SELECT * FROM ventures WHERE status = 'published' ORDER BY sort_order ASC LIMIT 1");
    console.log("D1 API Raw Response:", JSON.stringify(d1Result));

    let targetVenture = null;

    if (d1Result && d1Result[0] && d1Result[0].results && d1Result[0].results.length > 0) {
      targetVenture = d1Result[0].results[0];
    } else {
      console.log("No 'published' ventures found in results. Attempting fallback to any available row...");
      const fallbackResult = await queryD1("SELECT * FROM ventures ORDER BY sort_order ASC LIMIT 1");
      
      if (fallbackResult && fallbackResult[0] && fallbackResult[0].results && fallbackResult[0].results.length > 0) {
        targetVenture = fallbackResult[0].results[0];
      }
    }

    if (!targetVenture) {
      console.warn("D1 ventures table query returned nothing. Generating fallback portfolio structure...");
      targetVenture = {
        title: "My Tech Studio",
        excerpt: "Building high-performance MVPs, decentralized serverless systems, and minimal premium digital designs.",
        tech_stack: "['Next.js', 'React', 'Cloudflare Workers', 'D1', 'R2']",
        live_url: "https://github.com",
        github_url: "https://github.com"
      };
    }

    console.log(`Successfully targeted venture for promotion: "${targetVenture.title}"`);

    // B. Collect search facts
    const newsContext = await fetchTrendingTechNews();

    // C. Get high-quality images from Unsplash
    const images = await fetchUnsplashImages("technology development software business finance", 11);

    // D. Request article creation from GitHub Models LLM
    const generatedBlog = await generateBlogPost(newsContext, targetVenture, images);

    // E. Save local markdown backup inside the runner env
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

    // Prune overflow entries if total count exceeds 500 records
    try {
      await pruneOldBlogPosts();
    } catch (pruneError) {
      console.error("Non-blocking pruning error:", pruneError);
    }

    // G. Cross-post automatically to Dev.to
    await publishToDevTo(generatedBlog, images[0]);

    console.log("Automation task successfully executed!");

  } catch (error) {
    console.error("Pipeline failure:", error);
    process.exit(1);
  }
}

main();
