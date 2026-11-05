# Detail inventories

Open the section for the subject's domain (several when the image mixes them). Pick only what will be visible at the final size.
- **Include**: what a real one has. Name each item in the prompt.
- **Check**: what GPT Image tends to get wrong. Inspect each in the review.

## Devices: phones, tablets, laptops, watches
- **Include**: exact device and generation, and finish ("iPhone 16 Pro in natural titanium"); which side is shown (front or back); body and bezel thickness; the buttons that exact model has, on the right sides (iPhone: volume plus mute switch or Action button on the left, side button on the right, Camera Control low on the right edge on iPhone 16 models; check the model when it matters); camera bump with that model's lens count and layout; Dynamic Island, notch, or punch-hole as the model has; status bar laid out like the real one (on Dynamic Island iPhones: time left of the island; signal, Wi-Fi and battery right of it); real screen content (a believable app layout, short readable text, plausible data in the user's locale); a notification or widget when it fits the story; reflections on the glass that match the room; how it is held or what it rests on.
- **Check**: missing, extra, or misplaced buttons; wrong lens count or arrangement; two cutouts at the top; status icons clipped by the screen corner; garbled clock or status icons; gibberish UI text; screen content not following the rounded corners; a screen glowing brighter than the room allows; fingers passing through the device; laptop keyboard with wrong key layout.
- When the user has the real screenshot, pass it in `reference_images` and write "place exactly this screenshot on the screen, unchanged".

## App and web UI on its own
- **Include**: the platform's conventions (iOS tab bar, Android top app bar, web header); a consistent spacing grid; real content (names, prices, dates) instead of placeholders; one primary action; a small, coherent icon set; the status bar on mobile screens.
- **Check**: lorem ipsum or gibberish, mixed icon styles, misaligned columns, too many accent colors, buttons that look disabled.

## People and portraits
- **Include**: age, build, skin tone and texture, hair texture with flyaways, clothes with real fabric and fit for the place and season, what the hands are doing, where the eyes look.
- **Check**: finger count, hands actually touching what they hold, teeth, matching earrings, both eyes looking the same way, age drift, the same identity across a series, plastic skin.

## Vehicles
- **Include**: make, model, generation and color; badges in their real positions; wheel design, tire sidewalls, brake calipers; plate in the local format but unreadable; ride height and the contact shadow under the tires; the surroundings reflected in the paint; the road surface.
- **Check**: wheels misaligned or mismatched, asymmetric lights, mirrored or melted badges, warped body lines, wrong number of doors, missing wipers or mirrors.

## Food and drink
- **Include**: the dish's real components served the way restaurants or homes serve it; plate, glass, or cup material; utensils that fit the dish; crumbs, drips, condensation; steam only on hot food; a believable portion; the table surface.
- **Check**: ingredients fused together, impossible liquid shapes, steam on cold drinks, food too symmetric, utensils that make no sense for the dish.

## Interiors and architecture
- **Include**: style and era; real materials (wood grain, tile grout, plaster); light switches and outlets; every light source; furniture at true scale (doors about 2.0 to 2.1 m, seats about 45 cm high); a few lived-in items; a window view that fits the location; ceiling details.
- **Check**: bent verticals, impossible stairs or doors, floating furniture, repeated decor, shadows that disagree with the windows.

## Products and packaging
- **Include**: exact shape and material, label text in quotes, seams, caps and lids, surface finish (matte, gloss, frosted), something that shows scale, a contact shadow.
- **Check**: garbled or misspelled label, distorted logo, broken symmetry on round objects, product floating, reflections that ignore the light.

## Logos, icons, brand graphics
- **Include**: an idea rooted in the brand's name or what it does; one or two colors with hex codes; strong negative space; consistent stroke weight; still readable at 32 px.
- **Check**: extra or missing letters, details that vanish at small size, generic globes, swooshes, lightbulbs, and gradients when flat was asked.

## Posters, slides, infographics, social graphics
- **Include**: a grid with real margins; a clear hierarchy (title, subtitle, body); one accent color; a real design reference instead of "modern and sleek" (Swiss poster, editorial magazine, museum signage); as little text as the message allows.
- **Check**: every word letter by letter, cramped kerning, elements drifting off the grid, clutter, stock icons, decorative glow.

## Landscapes, sky, nature
- **Include**: vegetation and terrain of the actual region and season, light that matches the time of day, a plausible moon phase, weather traces (wet ground after rain, haze), something that shows scale.
- **Check**: cloned trees, clouds, or waves; shadows that disagree with the sun; reflections that do not match; oversaturated greens and skies.

## Animals
- **Include**: species or breed, coat or feather pattern, correct anatomy, natural pose and behavior, a habitat or setting that fits.
- **Check**: extra or missing limbs, tails or ears, the animal merging with people or objects, broken patterns, wrong eye shape.

## Streets and cities
- **Include**: region-specific details (sidewalk paving, poles and wires, signage style, plate format, which side traffic drives on), weather traces, vehicles and clothes of the right era, people at the right scale.
- **Check**: gibberish signs, duplicated cars or people, traffic on the wrong side for the country.

## Animated GIFs
- **Include**: one subject doing one simple action; a fixed camera and identical framing in every frame; the last frame leading back into the first; a limited palette; the frame count and speed that fit the motion.
- **Check**: the subject changing identity or size between frames, flicker in the background, a jump at the loop point, a frame count different from the one asked, double images or soft edges after smoothing.
