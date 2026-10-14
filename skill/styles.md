# Style recipes for GPT Image

Load this file when writing the prompt. Pick one style, follow its recipe, and keep the scene → subject → details → constraints order from SKILL.md.

Confidence tags:
- **TESTED**: verified in this project with real generations.
- **OFFICIAL**: any OpenAI primary source (docs, cookbook, launch posts, system cards, OpenAI's Codex imagegen skill). Launch posts were read through web.archive.org because openai.com blocked direct fetches.
- **COMMUNITY**: two or more non-OpenAI practitioner sources.
- **ANECDOTAL**: one non-OpenAI source, or an untested extrapolation. Treat as a hypothesis.

Source keys are listed at the end.

## Photography

### Phone snapshot (real, unpolished)
- **Use:** "looks like I took it with my phone", social posts, anything that must not look AI-made.
- **Recipe:** "Real photo taken with an ordinary smartphone, handheld at eye height, casual unposed snapshot" + who took it and when + existing light only (overcast, streetlight, window, phone flash) + everything roughly in focus, no background blur + flat phone HDR, muted colors, slightly cool or off white balance, exposure a touch dark, a little noise in the shadows + off-center framing, an edge cut off, ordinary clutter left in.
- **Avoid:** f-stops, 85mm, bokeh, golden hour, cinematic, studio, dramatic sky, glossy reflections, over-sharpened detail, 8K.
- **Confidence:** TESTED once (Escalade wallpaper, 9:16; the user judged it more real than an earlier "photorealistic, 35mm, f/2.8" prompt). OFFICIAL [O2 lists "iPhone photo" as a photoreal cue; O4 demo uses amateur photography, phone quality, everything in focus; O3 demo uses a wide phone photo with messy details].

### Professional / editorial / commercial
- **Use:** ads, campaigns, magazine look, polished portraits.
- **Recipe:** state the use ("editorial magazine photo", "fashion campaign image") + "professional photography" + specific subject, wardrobe, pose + named light (softbox, large window, fill flash) + lens look (35/50/85mm, shallow depth of field allowed) + natural poses + "no heavy retouching".
- **Avoid:** bare "premium", "cinematic", "stunning" with no concrete visual target; heavy retouching (plastic skin).
- **Confidence:** OFFICIAL [O2 writes ads as a creative brief with brand, audience and natural poses]. COMMUNITY [C1, C2].

### Analog film (35mm, disposable, instant)
- **Recipe:** "shot like a 35mm film photograph" or "2000s film-camera photo" + lens look + named light + "subtle film grain, natural color balance".
  - Disposable / flash: harsh on-camera flash, hot spot on the subject, fast falloff to dark background, slight vignette, soft focus.
  - Instant: white instant-photo border, thicker at the bottom, soft focus, warm low contrast.
- **Avoid:** named film stocks as the only cue; the research found none in OpenAI docs (ANECDOTAL).
- **Confidence:** OFFICIAL for 35mm and grain [O1, O2, O4]. COMMUNITY for disposable and instant [C3, C6]. ANECDOTAL for stock names [C3].

### Product / studio packshot
- **Recipe:** "premium product photography" + exact product, material and label (label text in quotes) + seamless light-gray to white background, or isolated + centered, slight three-quarter angle, generous padding + softbox lighting, clean highlights, controlled shadows + accurate materials (matte plastic, glass refraction, brushed metal).
- **Transparent cutout:** set `transparent_background: true`; do not describe any backdrop or color; write "isolated object on a fully transparent background, whole object visible, no backdrop, no plinth, no cast shadow, no checkerboard"; ask to keep refraction and fine edges.
- **Confidence:** OFFICIAL [O6 product mockup, O7 transparent assets, O1 cutout]. TESTED for alpha (PNG RGBA returned).

### Documentary / street / photojournalism
- **Recipe:** "candid documentary photograph" + real place, era, event, period-accurate details + people mid-action, unposed + available and practical light + 35mm or wide look + "grounded, unstyled, captured in the moment" + "no posed glamour, no postcard color grading". Motion blur and flash glare are allowed.
- **Confidence:** OFFICIAL [O1, O2 examples; O3 paparazzi-style demo]. COMMUNITY [C1, C2, C4].

### Cinematic film still
- **Use:** only when the user wants a movie look. OpenAI's guide advises avoiding "cinematic lighting" and "dramatic color grading" in real-photo prompts [O1]; it does not ban the word.
- **Recipe:** "cinematic film still" + aspect ratio in text (16:9 tested; 2.39:1 untested here) + shot type and lens look + one motivated, named light source + explicit palette or grade + atmosphere (haze, rain) with scale + grain + "no text overlays".
- **Confidence:** OFFICIAL for the scale/atmosphere/color rule [O1]. ANECDOTAL for the exact "film still" wording.

### Night and low light
- **Recipe:** name every light source and its color (sodium streetlight orange, cool shop fluorescent, warm windows), wet reflections if the ground is wet, visible grain or noise. Mood words alone ("moody night") trade realism for mood.
- **Confidence:** OFFICIAL rule [O1, O2]. COMMUNITY examples [C1, C2]. TESTED (fog plus streetlight in the Escalade photo).

### Portraits without plastic skin
- **Recipe:** "photorealistic candid photograph of" + age, occupation, specific features + real skin (pores, fine wrinkles, freckles, under-eye shadows, flyaway hair) + in-between expression, explicit gaze and pose + natural light from a named direction + lens look + "honest, unposed, no glamorization, no beauty retouching".
- **Avoid:** "flawless", "perfect skin", "beautiful", beauty-dish bokeh look.
- **Confidence:** OFFICIAL [O1 portrait example, O2 people guidance]. COMMUNITY [C2, C3, C4]. O2 recommends a higher quality setting for close-up portraits; this tool has no quality or size parameter, so expect more variance (ANECDOTAL).

### Macro, aerial / drone
- Only "macro detail" and viewpoint naming ("top-down", "aerial wide view") are documented [O2]. Add a familiar object for scale. Treat as ANECDOTAL.

## Illustration and design

### Flat vector / minimalist
- **Recipe:** "flat design illustration of" + subject + clean geometric shapes, strong silhouette, minimal strokes, balanced negative space + limited palette with hex codes + plain background color + "no gradients unless essential, no texture, no text, no watermark".
- **Confidence:** OFFICIAL [CB2 flat-design logo example; O3 shows hex colors in prompts].

### 3D render (clay, toy, plush, stylized)
- **Recipe:** "stylized 3D render of" + subject + one material (matte clay, glossy plastic, plush fabric, painted metal) + soft studio lighting, soft shadows, ambient occlusion + simple backdrop + "original design, no trademarks".
- **Avoid:** studio or brand names; "photorealistic" unless realism is wanted.
- **Confidence:** OFFICIAL for toy and plush [CB2, I15]. ANECDOTAL for clay wording (one prompt gallery).

### Watercolor, painting, ink, line art
- **Watercolor:** "hand-painted watercolor illustration" + soft edges + palette + mood + plain white background. OFFICIAL [CB2, O3].
- **Oil / gouache:** add "visible textured brushstrokes". OFFICIAL cue [CB15]; applying it to oil and gouache is untested.
- **Line art:** "thin solid black line on white, minimal outline, flat color, almost no shading". OFFICIAL [I20].
- **Engraving:** "vintage engraving print, fine hatching, aged paper texture". OFFICIAL [I20].

### Anime / manga-inspired
- **Recipe:** generic genre words only: "Japanese anime style", "hand-drawn retro anime", "shonen manga page", "clean cel shading" + panel layout if it is a page.
- **Avoid:** studio and artist names.
- **Confidence:** OFFICIAL wording [I15, I20]. I15 notes some specific art styles regressed in that model.

### Pixel art
- **Recipe:** "pixel art" + sprite size ("32x32 sprite") + number of colors + "crisp hard pixel edges, no anti-aliasing" + outline yes or no + plain or transparent background.
- **Confidence:** ANECDOTAL (one practitioner guide, no OpenAI source). Output may not be a true pixel grid; check edges before delivering.

### Comic / graphic novel
- **Recipe:** panel count and layout ("four equal panels, white gutters, padding around the border") + one visual beat per panel + dialogue in quotes per panel + style tag ("American retro comic", "modern indie comic").
- **Confidence:** OFFICIAL [CB2, O3, I20].

### Logos, icons, stickers
- **Logo:** "original logo for <name>, a <business>" + flat, simple, centered, generous padding, vector-like shapes, strong silhouette, readable small and large + transparent background. OFFICIAL [CB2, CB15].
- **Icon set:** "consistent icon set, same stroke weight, palette and perspective" + grid size ("4x4 grid, read left to right"). OFFICIAL [CB2, O3, I15].
- **Sticker:** "minimal <subject> sticker, thick white border, transparent background". OFFICIAL [O3].
- **Transparency wording:** "isolated on a fully transparent background, no scenery, no solid backdrop, no checkerboard, no unwanted shadows, crisp silhouette, no halos or fringing". OFFICIAL [CB2, CB15].

### Posters, infographics, UI mockups, typography
- **Text:** exact text in quotes or ALL CAPS; spell rare words letter by letter; "render exactly this text once, no extra characters"; font style, size, color, placement. OFFICIAL [CB2, CB15].
- **Poster hierarchy:** a "Poster text:" block listing the title and its position, then the headline, then the footer; state the language of all visible text. OFFICIAL [I20].
- **Infographic:** deliverable, audience, required components, real numbers; white background, neutral base palette, one accent color per card, equal panes, minimal text, no paragraphs. OFFICIAL [CB2, I15, I20].
- **UI mockup:** describe it as a shipped product, not concept art; layout, hierarchy, spacing, real UI elements, device frame, white background. OFFICIAL [CB2].
- **Known limits:** precise text placement and clarity. OFFICIAL [DOCS]. Dense small text, precise charts, long posters cropped at the bottom. OFFICIAL [O3]. Chinese, Arabic and Hebrew text still weak in 1.5. OFFICIAL [I15].

### Isometric
- **Recipe:** "true isometric projection" + which face is closest to the viewer + light direction + soft shadows and occlusion + plain background color. One forum report says numeric camera angles were ignored.
- **Confidence:** ANECDOTAL.

## Words that do not help

- Weak for GPT Image: "8K", "4K", "ultra HD", "masterpiece", "best quality", "trending on ArtStation", "award-winning", "epic", "rendered in Unreal Engine". These are tags from older diffusion models; output size comes from the aspect ratio, not from these words. COMMUNITY [C1, C3, C4].
- Harmful for natural realism: "cinematic", "dramatic lighting", "flawless skin", "studio", "perfect", "hyper detailed". OFFICIAL [O1, O2 avoid lists].
- There is no negative-prompt parameter. Write explicit exclusions ("no watermark, no extra text, no logos") instead of lists like "deformed, bad anatomy". OFFICIAL [CB2].
- OpenAI's own 1.5 demo used "hyper-realistic amateur photography" [O4, OFFICIAL], so a single hype word is not fatal; that the concrete capture description is what matters is ANECDOTAL.

## Policy

- Never name living artists or ask for "in the style of <living artist>". OFFICIAL [D3, SC4o].
- Press reports say studio-wide styles were allowed in 2025 while enforcement varied (ANECDOTAL); describe the attributes instead of naming studios.
- No copyrighted characters or trademarks the user does not own; add "original design" when relevant. OFFICIAL [CB2, MS].
- Photorealistic minors are blocked; adult public figures have safeguards. OFFICIAL [SC4o].

## Aspect ratios

- TESTED: "16:9" returned 1672x941, "9:16" returned 941x1672.
- OFFICIAL [I20] examples also use "4:5 portrait" and "3:1 ultrawide". OFFICIAL [DOCS]: the API accepts ratios from 1:3 to 3:1. Other ratios are untested here; check the size line in the result.

## Sources

- O1: https://developers.openai.com/api/docs/guides/image-prompting
- O2 / CB2: https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- CB15: https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide
- DOCS: https://developers.openai.com/api/docs/guides/image-generation
- O3: https://openai.com/index/introducing-4o-image-generation/
- O4 / I15: https://openai.com/index/new-chatgpt-images-is-here/
- I20: https://openai.com/index/introducing-chatgpt-images-2-0/
- O6: https://github.com/openai/skills/tree/main/skills/.system/imagegen
- O7: https://developers.openai.com/cookbook/examples/multimodal/transparent-image-assets-for-campaigns-and-presentations
- SC4o: https://cdn.openai.com/11998be9-5319-4302-bfbf-1167e093f1fb/Native_Image_Generation_System_Card.pdf
- D3: https://openai.com/index/dall-e-3/
- MS: https://model-spec.openai.com/2026-08-18.html
- C1: https://fal.ai/learn/tools/prompting-gpt-image-2
- C2: https://runware.ai/docs/models/openai-gpt-image-2/guides/prompting
- C3: https://www.hedra.com/blog/make-ai-images-look-like-real-photos-prompting
- C4: https://cloudinary.com/guides/image-generation/how-to-make-ai-images-look-real
- C6: https://carat.im/en/prompt-gallery/disposable-camera-photo
