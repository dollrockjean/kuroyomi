import os
import io
import time
import uuid
import database
import epub_parser

SAMPLE_VOL1_CHAPTERS = [
    ("Chapter 1: The Broken Seal", """
<p>The boundary bell chimed nine times across the jagged peaks of Mount Wu.</p>
<p>Kaelen brushed crimson dust from his sleeve, breathing in the cold mountain air. For seven years, he had been nothing more than an outer-sect sweeper, mocked for his severed spirit core.</p>
<p>"You're late with the tea, cripple," Senior Brother Bai spat, lounging upon the lacquered pavilion bench.</p>
<p>Kaelen lowered his gaze, his pulse steady beneath the fabric of his coarse linen tunic. He did not answer. He didn't need to.</p>
<p>Deep beneath his sternum, where doctors had declared his spiritual meridians withered beyond salvage, an obsidian spark pulsed in rhythm with his heartbeat.</p>
<p>[ System Diagnostic: Sovereign Core synchronized at 100%. ]</p>
<p>[ Divine Martial Archive initialized. Welcome back, Host. ]</p>
<p>The azure glyphs hovered in the corner of his peripheral vision, translucent and invisible to everyone else in the pavilion.</p>
<p>"Did you hear me, deaf dog?" Bai sneered, stepping closer, his palm crackling with azure lightning.</p>
<p>Kaelen gently placed the teapot onto the stone pedestal and looked up. For the first time in seven years, his eyes were not downcast.</p>
    """),
    ("Chapter 2: Ten Thousand Strikeless Cuts", """
<p>The courtyard fell dead silent.</p>
<p>Bai's lightning flickered erratically, disturbed by an imperceptible distortion in the surrounding gravity.</p>
<p>"Your footwork is sloppy, Senior Brother," Kaelen remarked quietly. "Your stance leans four inches too far forward on your left heel. In an actual trial of blood, a third-rank beast would have severed your femoral vein before you finished channeling."</p>
<p>"You dare lecture me?!" Bai roared, lunging forward with the sect's signature Gale Thunder Palm.</p>
<p>The wind howled, shattering the stone balustrade. Disciples gasped, expecting Kaelen's fragile body to be thrown fifty yards down the mountain slope.</p>
<p>Kaelen did not flinch. He simply shifted his weight backward half a step.</p>
<p>The air rippled. A single dark arc of condensed spiritual pressure manifested at the tip of his forefinger. It wasn't lightning. It was the void itself—hungry, silent, and absolute.</p>
<p>Bai's thunder collapsed into nothingness the moment it touched Kaelen's aura, as if swallowed by an abyss.</p>
<p>"This is impossible..." Bai gasped, falling to his knees as blood welled from his lips.</p>
<p>[ Objective Complete: Repel sect bully without drawing steel. ]</p>
<p>[ Reward: 500 Aether Shards. Unlocked Technique: Void Step Level 1. ]</p>
    """),
    ("Chapter 3: The Shadow Market of Luoyang", """
<p>Night descended like a veil of indigo silk over the subterranean streets of Luoyang.</p>
<p>Kaelen wore a bamboo hat pulled low over his eyes, his silhouette blending seamlessly with the shadows of the arched alleyways. In the black market, identity was a liability; only gold and spiritual stones held weight.</p>
<p>"Old man," Kaelen said, stopping before an unassuming stall covered in cracked jade talismans and rusted relics.</p>
<p>The merchant, a withered cultivator whose one remaining eye glowed with sickly jade light, squinted at him through smoke rings.</p>
<p>"If you came for charms, kid, go to the east pavilion. I only trade in dead men's curses."</p>
<p>Kaelen pointed to an unassuming shard of black metal half-buried beneath dried medicinal roots. "How much for the rusted iron scraper?"</p>
<p>The old man chuckled hoarsely. "Three low-grade spirit stones. Found it in the belly of an abyssal serpent sixty leagues past the forbidden mist."</p>
<p>Kaelen tossed three luminescent blue stones onto the wooden counter. His fingers closed around the cold metal.</p>
<p>[ Item Identified: Fragment of the Abyssal Sovereign Blade (1/7). ]</p>
<p>[ Passive: Absorbs ambient spiritual essence at double speed. ]</p>
<p>A faint smile tugged at Kaelen's lips. The pieces of the grand puzzle were finally returning to their rightful master.</p>
    """),
    ("Chapter 4: Undercurrents in the Grand Pavilion", """
<p>The morning mist in the Grand Hall smelled faintly of burning sandalwood and incense.</p>
<p>Elder Han sat atop the throne of white jade, his long grey beard trembling with barely restrained fury. Before him lay Bai, wrapped in medicinal bandages, unconscious.</p>
<p>"Who shattered his meridians?" the Elder's voice shook the rafters like muffled thunder.</p>
<p>"It was... the mute sweeper boy from the outer courtyard," one of the inner disciples stuttered, his head pressed flat against the polished flagstones.</p>
<p>"Absurd!" an elder shouted. "That boy's dantian has been dead since the day he crawled out of the Southern Desolation!"</p>
<p>"Send the Enforcement disciples," Elder Han ordered coldly. "Bring him to the Judgment Chamber before dusk. If he resists, break his legs."</p>
<p>High above on the clay roof tiles, a lone raven cocked its head, its obsidian eyes reflecting the Grand Hall below.</p>
<p>Through the raven's sight, five miles away in a secluded bamboo grove, Kaelen smiled softly and closed his eyes in meditation.</p>
    """),
    ("Chapter 5: Ascent to the Upper Realms", """
<p>The trial bells echoed through the ravine, announcing the commencement of the Heavenly Ascent Tournament.</p>
<p>Over three hundred disciples gathered around the Colosseum of Heaven, banners of crimson and gold snapping in the gale.</p>
<p>When Kaelen stepped onto the combat ring, whispers spread like wild prairie fire.</p>
<p>"Is that really him? He didn't flee?"</p>
<p>"Look at his posture... how is his aura completely untraceable?"</p>
<p>Across from him stood Meng Tian, the number one genius of the Inner Sect, wielding a spear forged from astral silver.</p>
<p>"Kaelen," Meng Tian said with contempt. "You got lucky with Bai. But before my Astral Lance, your cheap tricks will burn to ashes."</p>
<p>Kaelen took a slow breath. The black shard inside his pocket hummed with resonance.</p>
<p>"Draw your weapon, Senior Brother Meng," Kaelen replied calmly. "You will only have one chance."</p>
    """)
]

SAMPLE_VOL2_CHAPTERS = [
    ("Chapter 6: The Obsidian Citadel Rises", """
<p>The gates of the Obsidian Citadel loomed three hundred feet into the storm clouds.</p>
<p>Kaelen stood upon the black basalt ramparts, the wind whipping his long dark mantle behind him. A year had passed since the Heavenly Ascent Tournament. The Mount Wu sect was now an ally, and his name was whispered with awe across the Nine Provinces.</p>
<p>"Lord Kaelen," a woman's voice echoed behind him. It was Xiao Rou, commander of the Voidguard, her curved blades sheathed at her hips.</p>
<p>"Has the courier from the Imperial Capital arrived?" Kaelen asked without turning.</p>
<p>"He brought a decree from the Empress herself," she replied, kneeling gracefully. "She demands your presence at the Solstice Banquet."</p>
<p>Kaelen looked toward the eastern horizon, where violet lightning flashed between twin mountain peaks.</p>
<p>"A banquet," he mused. "Or an ambush of thousand-fold celestial arrays?"</p>
<p>"Our scouts report that seven grandmasters have already gathered within the Capital gates," Xiao Rou cautioned.</p>
<p>"Good," Kaelen said, his eyes glowing with an abyssal violet brilliance. "It saves me the trouble of hunting them down one by one."</p>
    """),
    ("Chapter 7: Feast of the Seven Emperors", """
<p>The Imperial Palace of Zhao was carved from a single block of translucent white crystal, illuminated by thousands of floating sun-pearls.</p>
<p>Nobles and sovereigns in gold-embroidered robes raised chalices of jade nectar, while ethereal dancers moved to the music of jade flutes.</p>
<p>Yet an icy undercurrent ran beneath the lavish celebration.</p>
<p>"Lord Sovereign Kaelen arrives!" the herald cried, his voice trembling despite his training.</p>
<p>Every conversation ceased instantly.</p>
<p>Kaelen walked through the grand archway unhurriedly, flanked only by Xiao Rou. He wore no armor, no ceremonial silk—only simple black robes with silver dragon stitching along the collar.</p>
<p>The Seven Grandmasters seated along the eastern dais exchanged cold, calculating glances.</p>
<p>"So you are the rising sovereign who claims the northern wilderness," spoke Grandmaster Yan, an elder clad in crimson flame robes.</p>
<p>"I claim nothing that was not already mine," Kaelen responded, taking a seat at the center table uninvited.</p>
    """),
    ("Chapter 8: The Celestial Trap", """
<p>Without warning, the crystal pillars of the Grand Hall flared blinding white.</p>
<p>Runes of sealing crawled across the marble floors, locking the space in an impenetrable spatial cage.</p>
<p>"Kaelen!" Empress Zhao rose from her throne, her voice echoing with sovereign decree. "Your power disrupts the balance of the Nine Realms. Surrender your Sovereign Core, and you shall be granted a peaceful domain in the western dunes!"</p>
<p>Kaelen did not flinch. He slowly lifted his wine cup, took a sip, and set it down with a soft click that resonated through the entire palace.</p>
<p>"You spent three years preparing the Nine Heavens Sealing Array," Kaelen remarked.</p>
<p>The Empress's eyes widened.</p>
<p>"You bribed four grandmasters and sacrificed a million spirit stones to anchor it to the earth veins beneath this city," he continued smoothly.</p>
<p>"If you knew... why did you walk into it?" Grandmaster Yan shouted, rising with flames erupting around his fists.</p>
<p>"Because," Kaelen whispered, "an array anchored to earth veins is simply a banquet of energy waiting to be consumed."</p>
    """),
    ("Chapter 9: The Void Consumes the Stars", """
<p>Kaelen slammed his palm onto the polished marble floor.</p>
<p>A black vortex expanded outward from his hand like an ink spill in clear water. The blinding white runes of the Imperial Sealing Array didn't shatter—they dissolved, their holy light turning pitch black as pure primordial essence rushed into Kaelen's body.</p>
<p>[ Divine Martial Archive: Celestial Array detected. ]</p>
<p>[ Converting 10,000,000 units of divine essence... Sovereign Core breakthrough initiated! ]</p>
<p>The roof of the Imperial Palace shattered as a pillar of dark violet light shot directly into the heavens, piercing the clouds and revealing the daylight stars.</p>
<p>The Seven Grandmasters fell backwards, their protective barriers disintegrating under the overwhelming pressure.</p>
<p>"Is he a mortal or a calamity?!" Yan screamed in despair.</p>
    """),
    ("Chapter 10: Sovereign of the Infinite Void", """
<p>Silence returned to the ruins of the crystal palace.</p>
<p>The clouds above had parted into a vast spiraling eye, centered directly above Kaelen.</p>
<p>Empress Zhao leaned against the broken remains of her throne, tears of disbelief streaming down her porcelain cheeks.</p>
<p>"What... what are you?" she breathed.</p>
<p>Kaelen stepped forward, the obsidian blade in his hand humming with quiet contentment. The world felt different now. He could feel the breath of the wind five thousand miles away; he could perceive the turning of the planetary core beneath his feet.</p>
<p>"I am the sovereign who walks between the stars," Kaelen said.</p>
<p>He turned toward Xiao Rou with a faint, warm nod. "Send word to the Obsidian Citadel. The Nine Realms are united."</p>
<p>[ End of Volume 2: The Obsidian Citadel ]</p>
<p>[ Reading Complete. Volume 3: Beyond the Astral Sea coming soon. ]</p>
    """)
]

def seed_demo_novel(user_id: str):
    conn = database.get_db()
    cur = conn.cursor()
    
    # Check if novel already seeded for this user
    cur.execute("SELECT id FROM novels WHERE user_id = ? AND title = ?", (user_id, "Chronicles of the Aether Sovereign"))
    if cur.fetchone():
        conn.close()
        return
        
    now = time.time()
    novel_id = f"nov_{uuid.uuid4().hex[:12]}"
    
    # Minimal SVG brutalist cover
    cover_svg = """<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <rect width="100%" height="100%" fill="#121212"/>
  <rect x="15" y="15" width="370" height="570" fill="none" stroke="#facc15" stroke-width="4"/>
  <line x1="15" y1="90" x2="385" y2="90" stroke="#facc15" stroke-width="2"/>
  <line x1="15" y1="510" x2="385" y2="510" stroke="#facc15" stroke-width="2"/>
  <text x="30" y="60" fill="#facc15" font-family="sans-serif" font-size="14" font-weight="bold" letter-spacing="1">WEB NOVEL · SERIES 01</text>
  <text x="30" y="180" fill="#ffffff" font-family="Times New Roman, serif" font-size="32" font-weight="bold">CHRONICLES</text>
  <text x="30" y="225" fill="#ffffff" font-family="Times New Roman, serif" font-size="32" font-weight="bold">OF THE</text>
  <text x="30" y="270" fill="#facc15" font-family="Times New Roman, serif" font-size="34" font-weight="bold">AETHER SOVEREIGN</text>
  <circle cx="200" cy="380" r="55" fill="none" stroke="#00f0ff" stroke-width="3" stroke-dasharray="8 4"/>
  <polygon points="200,340 240,410 160,410" fill="#facc15"/>
  <text x="30" y="545" fill="#888888" font-family="sans-serif" font-size="13">Volumes 1 &amp; 2 Included · 10 Chapters</text>
</svg>"""
    import base64
    cover_b64 = "data:image/svg+xml;base64," + base64.b64encode(cover_svg.encode('utf-8')).decode('utf-8')
    
    cur.execute("""
        INSERT INTO novels (id, title, author, description, cover_data, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        novel_id,
        "Chronicles of the Aether Sovereign",
        "Master Jin Kaelen",
        "A multi-volume epic web novel serialized across two volumes. Follow Kaelen's ascension from a crippled outer-sect disciple to the Sovereign of the Infinite Void.",
        cover_b64,
        user_id,
        now,
        now
    ))
    
    # Volume 1
    vol1_id = f"vol_{uuid.uuid4().hex[:12]}"
    cur.execute("""
        INSERT INTO volumes (id, novel_id, volume_number, title, file_name, total_chapters, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (vol1_id, novel_id, 1, "Volume 1: Awakening of the Void", "Aether_Sovereign_Vol1.epub", len(SAMPLE_VOL1_CHAPTERS), now))
    
    global_idx = 1
    for idx, (title, content) in enumerate(SAMPLE_VOL1_CHAPTERS, 1):
        ch_id = f"ch_{uuid.uuid4().hex[:12]}"
        clean_html, wc = epub_parser.clean_html_content(content, None, "")
        cur.execute("""
            INSERT INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (ch_id, novel_id, vol1_id, idx, global_idx, title, clean_html, wc))
        global_idx += 1
        
    # Volume 2
    vol2_id = f"vol_{uuid.uuid4().hex[:12]}"
    cur.execute("""
        INSERT INTO volumes (id, novel_id, volume_number, title, file_name, total_chapters, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (vol2_id, novel_id, 2, "Volume 2: The Obsidian Citadel", "Aether_Sovereign_Vol2.epub", len(SAMPLE_VOL2_CHAPTERS), now))
    
    for idx, (title, content) in enumerate(SAMPLE_VOL2_CHAPTERS, 1):
        ch_id = f"ch_{uuid.uuid4().hex[:12]}"
        clean_html, wc = epub_parser.clean_html_content(content, None, "")
        cur.execute("""
            INSERT INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (ch_id, novel_id, vol2_id, idx, global_idx, title, clean_html, wc))
        global_idx += 1
        
    # Initialize reading progress at Chapter 1, paragraph 0
    cur.execute("SELECT id, volume_id FROM chapters WHERE novel_id = ? ORDER BY global_index ASC LIMIT 1", (novel_id,))
    first_ch = cur.fetchone()
    if first_ch:
        cur.execute("""
            INSERT OR REPLACE INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (f"prog_{uuid.uuid4().hex[:12]}", user_id, novel_id, first_ch["volume_id"], first_ch["id"], 0, 0.0, now))
        
    cur.execute("UPDATE users SET demo_seeded = 1 WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    print("Demo novel successfully seeded!")
    return novel_id

if __name__ == "__main__":
    database.init_db()
    uid = database.get_or_create_user("DEFAULT_READER", "Pioneer Reader")
    seed_demo_novel(uid)
