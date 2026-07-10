# minima melt — DESIGN CONTRACT (canonical)

minimaシリーズ6機目。**アシッド（TB-303系）グルーヴボックス**。差し色 = **紫**（毒々しく発光する溶解物の紫＋淡いラベンダーの光）。
アーキテクチャは galaxy/drift/city/fission と同一: 素Web Audio + AudioWorklet 自前DSP、全部シンセ（サンプル無し）、Electron。src/ はそのまま Web(Pages) にもなる。

**この表が唯一の正**。DSP既定値と index.html のスライダー value は必ず一致させること（起動時 pushAllState がHTML値をエンジンへ送るため、ズレると鳴らない）。

## 音のキャラ
- アシッドテクノ。**BPM 130** 既定。16 step = 1小節（16分）。
- 主役は **ACID（303ボイス）**: 鋸↔矩形モーフ、強レゾナンスLPF、**per-stepピッチ＋accent＋slide** の3レイヤー打ち込み、filter envのビチャっとしたプラック、内蔵drive。galaxyの src/audio/dsp/bass303.js を出発点に拡張してよい（wave morph / drive / envMod を追加）。
- 脇: 4つ打ちキック、16分ハット（offbeat open）、クラップ。
- ヒーローマクロ **MELT（溶解）** 0..1: 上げるほど音がどろどろに溶ける。
  - cutoff に遅いLFOうねり（~0.15〜0.35Hz、深さ ∝ melt、最大 ±1.5oct）
  - reso +0.2×melt（上限 0.97）
  - **pitch droop**: 点灯stepごと per-loop乱数で最大 -5半音×melt の下方デチューン（glideで到達＝音程がとろけ落ちる）。適用確率 ∝ melt
  - 非slide step が slide 化する確率 ∝ melt（フレーズが繋がってどろける）
  - delay feedback +0.12×melt
  - **>0.7: bubble pops** — フィルター自己発振ピング（泡がはじける音）をランダム挿入
  - xorshift自前乱数、**step0 ごとに再シード**、melt=0.0 で完全に原パターン復帰（drift DESCENT / fission CRITICAL と同流儀）

## processor / ファイル
- `registerProcessor('melt-engine', ...)` — src/audio/engine-processor.js
- dsp モジュール: src/audio/dsp/{kick,hat,clap,acid,effects,util}.js（pure module、Workletグローバル非依存。fissionと同流儀）
- test: test/render-voices.js, test/render-effects.js（node で WAV 書き出し、test/wav.js はfissionから流用）

## トラック / ステップ行
| track (mute名) | step行 | 内容 |
|---|---|---|
| kick | `kick` | 4つ打ちテクノキック |
| hat  | `hatC`, `hatO` | closed / open（hatO発音でhatC choke） |
| clap | `clap` | クラップ |
| acid | `acid` (+ `acidNotes[16]` 半音 -12..+12, `acidAcc[16]` 0/1, `acidSlide[16]` 0/1) | 303。slide=1 のstepは前ノートから無リトリガーでグライド |

## 既定パターン（16step、1=点灯）
- kick:  steps 0, 4, 8, 12（4つ打ち）
- hatC:  {2,6,10,14} **以外** の全step（16分刻み、offbeatはopenに譲る）
- hatO:  steps 2, 6, 10, 14（offbeat open）
- clap:  steps 4, 12
- acid:  steps 0, 2, 3, 5, 7, 8, 10, 11, 14, 15
- acidNotes: 全16=0、ただし step3=+12, step7=+3, step10=-2, step11=+12, step14=+7, step15=+5
- acidAcc:   steps 0, 7, 11 = 1
- acidSlide: steps 3, 8, 15 = 1

## パラメータ表（canonical — DSP既定 = HTML value）
range はスライダー min/max/step。

### KICK (track `kick`)
| name | range | default |
|---|---|---|
| tune | 30..70 step1 | 46 |
| decay | 0.1..0.6 step0.01 | 0.32 |
| punch | 0..1 step0.01 | 0.6 |
| drive | 0..1 step0.01 | 0.3 |
| level | 0..1 step0.01 | 0.9 |

### HAT (track `hat`)
| name | range | default |
|---|---|---|
| tone | 0..1 step0.01 | 0.6 |
| decayC | 0.01..0.15 step0.005 | 0.04 |
| decayO | 0.05..0.6 step0.01 | 0.22 |
| level | 0..1 step0.01 | 0.45 |

### CLAP (track `clap`)
| name | range | default |
|---|---|---|
| tone | 0..1 step0.01 | 0.55 |
| decay | 0.05..0.5 step0.01 | 0.22 |
| spread | 0..1 step0.01 | 0.5 |
| level | 0..1 step0.01 | 0.6 |

### ACID (track `acid`) — 主役、ノブ10本
| name | range | default | 内容 |
|---|---|---|---|
| root | 0..11 step1 | 9 (A) | 基準はA1系: root=9 が A1 (~55Hz) |
| wave | 0..1 step0.01 | 0 | 鋸(0)↔矩形(1)モーフ |
| cutoff | 80..3000 step10 | 380 | LPFベース周波数 |
| reso | 0..1 step0.01 | 0.75 | レゾナンス |
| envMod | 0..1 step0.01 | 0.65 | filter env深さ（=303のENV MOD） |
| decay | 0.05..0.6 step0.01 | 0.18 | filter env decay |
| accent | 0..1 step0.01 | 0.7 | accent step の音量＋env増し |
| glide | 0.01..0.2 step0.005 | 0.055 | slide時間(秒) |
| drive | 0..1 step0.01 | 0.35 | ボイス内サチュレーション |
| level | 0..1 step0.01 | 0.8 |  |

### FX（`fx` メッセージ、name/value）
| name | range | default | 内容 |
|---|---|---|---|
| delay | 0..1 step0.01 | 0.3 | 付点8分テンポ同期DubDelayのsend量（acid中心、hat/clap少量） |
| feedback | 0..0.9 step0.01 | 0.5 | ディレイfeedback |
| reverb | 0..1 step0.01 | 0.15 | 小plate、clap/acid send |
| crush | 0..1 step0.01 | 0.06 | バスbitcrush（質感） |
| duck | 0..1 step0.01 | 0.4 | kick以外をサイドチェイン |
| swing | 0..0.3 step0.01 | 0.02 | 16分スイング |

### その他
| 項目 | 値 |
|---|---|
| bpm | 60..190 step1、default **130** |
| master | 0..1、default 0.85（プレビュー検証時は 0.04 に落として聴取） |
| melt | 0..1、default 0 |
| localStorage key | `minima-melt-v1` |
| PTN スロット | 4（galaxy/drift/fission と同じ） |

## メッセージ契約
- UI→engine: `{type:'play'}` `{type:'stop'}` `{type:'bpm',value}` `{type:'master',value}` `{type:'mute',track,value}`（track: kick|hat|clap|acid） `{type:'steps',track,steps[16]}`（track: kick|hatC|hatO|clap|acid） `{type:'param',track,name,value}` `{type:'fx',name,value}` `{type:'melt',value}` `{type:'acidNotes',notes[16]}` `{type:'acidAcc',flags[16]}` `{type:'acidSlide',flags[16]}`
- engine→UI: `{type:'step',index}` のみ。

## DSP実装メモ
- kick: sine pitch-sweep + click(punch) + tanh(drive)。fission流用可、テクノ寄りにdecay長め。
- hat: 矩形波金属クラスタ or HPFノイズ、toneでHPF。hatO発音時にhatCをchoke。fission流用可。
- clap: HPF/BPFノイズ×3連バースト（spreadでバースト間隔とステレオ感）＋短いテール。
- acid: galaxy bass303.js 拡張。polyblep鋸＋polyblep矩形をwaveでクロスフェード。SVF lowpass(cutoff,reso)。filter env: env×(1+accent×1.5)、fc=cutoff×2^(envMod×env×4)上限12k。slide=noteOn(note,acc,slide=true)でglideCoefで追従。tanh drive。MELTのLFO/droop/bubbleはengine側でcutoff・noteに介入してよい（voice paramは不変、melt=0で完全復元を保証）。
- effects: DubDelay(付点8分)/plate reverb/bitcrush/ducker は fission の effects.js を流用改変してよい。
- master = tanh(mix * master)。
- bubble pop: 高resoのSVFにインパルス＋ランダムピッチ(800〜3000Hz)の短いping、level小さめ。

## ビジュアル契約（2026-07-10 第3版 — [[minima-new-module-design-rule]] 全面改訂版準拠）

**構図の骨格宣言: 重力カスケードの正面壁。** 画面全体が「溶けて滴り落ちる液体の空間」そのもの。上＝天井から垂れ下がる巨大な粘液の塊、中＝その下縁から直接ぽたぽた垂れる16の雫、下＝溶けた液体が溜まる発光の池。視線は正面固定、支配する力は重力ひとつ。既存機の骨格（galaxy放射軌道/rain窓タブロー/drift一点透視/cityアイソメ/fissionオーブ+リング/smokeレコード盤）のどれとも異なること。**旧版のfission型テンプレ（中央シンボル+傾斜楕円リング16ノード+周回プレイヘッド+四隅の浮遊アイコン+左上縦ウィジェット）は使用禁止。シーンSVGコードを前バージョン・他機からコピーするのも禁止（ゼロから書く）。流用可はインフラのみ（grain/vignette/glowフィルタ定型、エディタ、audio配線）。**

**モチーフの原理 = 粘度。** すべての動きは「粘度の高い液体」の物理に従う: ゆっくり伸びる→くびれる→千切れる→ぷるんと戻る。糸は必ずカテナリーに垂れ、雫は涙滴形で落下中に伸び、着水は重く波打つ。時定数は蜂蜜（速い動きにも必ず遅れて追従する残りがある）。

- 画材（不変）: 漆黒シネマティック背景＋強フィルムグレイン＋ビネット＋EB Garamond＋白線画・発光オーブのみ。塗り面・グレー・リアルイラスト禁止。差し色 `--accent: #a34dff` / `--accent2: #d9b3ff`、発光部のみ控えめに。
- **液塊（上部、主役面積）= 天井から垂れ下がる巨大な粘液の塊**（2026-07-10改訂: 旧「MELT」バブルレターはユーザーNG「名前がアルファベットででかでかは違う」→文字ではなく液体そのものを主役に）: 画面上端から幅いっぱいに、どろりと垂れ下がる溶けた液体のシート/塊。輪郭は白線画＋内側に紫エコー線＋発光グラデ、下縁は重たいローブ（丸いふくらみ）が不均一に連なり、常時とろりとwobbleして下縁全体がゆっくり波打つ。**= 再生トグル**（**pointerdown束縛**、class `sun` 維持）。再生中はゆったり脈動、キックで塊全体がぶるんと震えて池に波紋。文字・ロゴの類は入れない。
- **溶けたドクロ = 再生ボタンの目印**（2026-07-10追加: ユーザー「再生ボタンの位置がわからない。溶けちゃったイメージでドクロとか」）: 液塊の中央に**半分溶けかけたドクロ**が埋まっている（白線画: 丸い頭蓋＋大きな2つの眼窩＋鼻孔、顎から下は溶けて塊のローブに流れ込み輪郭が途切れる。ドクロ自体も常時わずかにwobble）。液塊と同じ `sun` グループ内＝タップで再生/停止。**停止中: 眼窩の下に小さな▶グリフが紫に光って「ここが再生」だと示す＋ドクロは薄暗い**。**再生中: ▶は消え、眼窩がビート（kickEnv）で明滅し、ドクロがうっすら発光**。ロード中は`.loading`減光に従う。
- **16ステップ = 液塊の下縁から直接ぽたぽた**: 棒・糸は使わない。液塊の下縁、等間隔の16箇所が**ドリップポイント（乳頭状の小さなふくらみ）**になっており、消灯=かすかなふくらみのみ。点灯=そこから**重い雫が直接ふくらんで垂れ、紫に発光**（雫のサイズ・垂れ具合はランダムに違い、今にも落ちそうにぷるぷる）。**accentの点灯stepは雫がひと回り大きく明るく、根元のふくらみも肥大**。**slideのstepは隣のドリップポイントと下縁の膜がねばっと繋がって垂れる**（液体の橋）。タップ入力は不要（打ち込みはエディタ）。
- **プレイヘッド = 粘性グロブ**: 光る飴状の塊が**液塊の下縁に沿って**左→右に這って進む（液体の中を移動する明るいふくらみ、下縁がそこだけ盛り上がる）。移動のたび前の位置から**糸を引いて伸び→くびれて千切れ→ぷるんと合体**（蜂蜜の歩き方）。点灯ドリップポイントを通過すると、その雫を**搾り出すように千切って池へ落下→重いスプラッシュ＋同心の粘った波紋**（波紋は速く広がらず、もったり減衰）。停止時は step0 のドリップポイントで休む（opacity 0.28）。
- **池（下部全幅）＋ MELT蛇口（右下）= MELTマクロ**（2026-07-10改訂: 「蛇口と関係なく水面をスワイプはおかしい。右下に蛇口を置いて、スワイプで蛇口が開いて水位が上がる形に」）: 画面下端に溶けた絵の具の池（白線画の水面線＋紫グロー＋発光グラデfill）。**右下、池の最大水位より上（ACIDスポイトと重ならない位置）に白線画のMELT蛇口**が右端の壁から突き出ている（パイプ＋池へ向く下向きスパウト＋十字ハンドル）。**蛇口を上下スワイプ（ドラッグ）すると開き**、ハンドルが開度に応じて回転し、スパウトから光の流れが池へ注がれ（流れの太さ・明るさ∝melt）、**水位が追従して上がる＝MELT量**。閉じる方向で水位低下。melt=0で流れ停止（時々ぽたり程度）。蛇口の下にセリフラベル **MELT** と **%表示**。池面の直接上下ドラッグも従来どおり併用可（副導線）。FXパネル `#melt-slider` と双方向ミラー維持。左上のGEN蛇口（液塊へ注ぐ・タップ=全ランダマイズ）とは「注ぎ先と機能が違う2つの蛇口」として共存: 上=パターンを注ぐ、右下=溶解液を注ぐ。高MELTで: 液塊がだらだらと下方へ垂れ下がって画面中央へ迫る・下縁のローブと雫が肥大し伸びる・池面が沸き立ち（DSPのbubble popに同期して泡が浮かんで弾ける）・壁全体の発光がゆらぐ。
- ~~GEN蛇口~~（2026-07-10撤去: ユーザー「左上の蛇口いらない」。シーンの蛇口はMELT蛇口の1本だけにする。ランダマイズはエディタ内の各トラックGENボタンのみ）
- **4トラック = 泡に包まれて液塊の中を漂うガラス器具**（2026-07-10再改訂: ユーザー「試験管とかのガラス機器系は泡に包まれて液体の中を漂ってて」。壁の棚置き→浮遊へ）: KICK=**三角フラスコ**、HATS=**試験管2本**、CLAP=**ビーカー**、ACID=**スポイト**の白線画。各器具は**1つの透明な泡**（白線の円＋上部にハイライト弧、うっすら紫グロー）に封入され、**巨大液塊の体内をゆっくり漂う**: 水平にゆったり流され、上下にもわずかに揺れ（sinベースのドリフト、互いに位相違い）、液塊下縁より上・画面上端より下に収まる。器具の中の紫発光液＋微小泡は維持。セリフラベルは泡の下に随伴。**タップでそのトラックのエディタ**（泡ごと当たり判定が追従）、**ミュートで液の発光が消え泡ごと減光**。池までの垂れ筋は廃止（浮遊体なので）。高meltでは液塊が下がるのに合わせて漂いも低く・速く（かき混ぜられる感じ）。
- 背景の壁: 微細なミスト浮遊粒＋乾いた古い液垂れの縦筋。旧作の「周回する彗星」的要素は使わない（この世界の動きはすべて下方向）。
- エディタ/操作系（インフラ、不変）: ステップ入力行、パラメータスライダー群、MUTE/GEN、PTN 4スロット、BPM/master。ACIDは per-step 上下ドラッグで音程（半音、音名表示）＋ ACC / SLIDE のトグル行。
- タイトル: `minima melt` ＋ サブコピー "molten acid machine"。
- セルフチェック: 差し色を緑に替えてもfissionに見えないこと／紫のままでも「fissionの色違い」に見えないこと。構図で判別できること。

## 検証メモ
- 再生トグルは pointerdown 束縛のため合成clickでは反応しない → preview_eval で PointerEvent('pointerdown') を dispatch して検証（fissionで確立済み）。
- プレビュー: Documents/.claude/launch.json に **melt-web (port 5178)** を追加。
