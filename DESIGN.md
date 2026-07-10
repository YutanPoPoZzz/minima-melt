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

## ビジュアル契約（galaxy DNA 必須）
[[minima-new-module-design-rule]] 準拠: **galaxyの src/{index.html,style.css,renderer.js} を実コピー元にしてテーマ差分を当てる**。
- 共通言語: 漆黒シネマティック背景＋強フィルムグレイン＋ビネット＋EB Garamond＋「白い光の肉抜き／発光オーブ・光跡」のみ。塗り・グレー・リアルイラスト禁止。
- 差し色: `--accent: #a34dff`（紫）/ `--accent2: #d9b3ff`（淡ラベンダー）。基調は白黒のまま、差し色は控えめに（発光部のみ）。
- シーン = **溶解体**:
  - 中央 = **溶けた発光コア**: どろりと波打つ有機ブロブ（SVG pathをゆっくりwobbleアニメ）＋下辺から粘性の滴りが糸を引いて時々落ちる。= 再生トグル（galaxyの太陽相当、**pointerdown束縛**）。再生中は強く脈動し滴りが増える。
  - 16ステップ = コアを囲むリング上の16個の**雫ノード**（滴型）。点灯step=紫の光球（下に垂れた光の尾）。**accent点灯stepはより大きく明るく**、**slide stepは前のstepと細い光の糸で繋がる**。
  - プレイヘッド = リングを周回する**溶けた滴**（光る粘液玉＋垂れ気味の光跡。drift car / fission neutron方式）。点灯ノード通過時に**スプラッシュ**: 飛沫の光滴が2〜3個飛ぶ＋波紋リング＋ノードが一瞬びよんと伸びる。停止時は step0 にパーク（opacity 0.28）。
  - 4トラック = 周囲に浮かぶ4つの**小さな溶塊**（半分溶けかけた形の白線画＋発光ドット、galaxyの惑星相当）。タップでそのトラックのエディタへ、ミュートで減光。ラベル KICK/HATS/CLAP/ACID（セリフ）。
  - MELT = 左上の**溶ける柱**（制御棒相当）: 白線画の垂直な柱が下ほど溶けて歪み、根本から滴が糸を引く。**下ドラッグで溶解量**、%表示。FXパネルにミラースライダー `#melt-slider`。高MELTで: コアがだらりと垂れ下がる・軌道リングが波打つ・背景の落下滴ストリーク増加・発光がゆらぐ。
  - 背景: 微細粒子の星野＋時々上から落ちる光の滴ストリーク（galaxyの彗星相当）。
- エディタ/操作系: galaxyのUI構造（ステップ入力、パラメータスライダー群、MUTE/GEN、PTN 4スロット、BPM/master）をそのまま踏襲し、行構成とパラメータ名だけ本表に差し替え。ACIDはgalaxy BASS同様 per-step 上下ドラッグで音程（半音、音名表示）＋ **ACC / SLIDE のトグル行**（点灯式）を追加。
- タイトル: `minima melt` ＋ 小さな英字サブコピー（例: "molten acid machine"）。

## 検証メモ
- 再生トグルは pointerdown 束縛のため合成clickでは反応しない → preview_eval で PointerEvent('pointerdown') を dispatch して検証（fissionで確立済み）。
- プレビュー: Documents/.claude/launch.json に **melt-web (port 5178)** を追加。
