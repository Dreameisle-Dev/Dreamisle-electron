// 歌词文件里的制作信息（credits）识别。
//
// 本地 LRC 常在开头/结尾写「作词：…」「作曲：…」「赞助：…」「℗ …」等，
// 有些还带时间戳，会混进主歌词、小窗歌词、桌面歌词和任务栏歌词。
// 这里按**整行**剔除，不做行内截断 —— 避免把「作词：…」后面同一行的真实歌词一起删掉。
// 所有规则都锚定行首，只有明确的「标签 + 分隔符」、英文 `... by ...` 和
// 版权/赞助整句才会命中，避免误伤正文里出现「作曲」「赞助」等词的歌词。

const CN_LABELS = [
  // 词曲 / 制作
  '作词',
  '作詞',
  '作曲',
  '编曲',
  '編曲',
  '词曲',
  '詞曲',
  '制作人',
  '製作人',
  '制作',
  '製作',
  '监制',
  '監製',
  '音乐监制',
  '音樂監製',
  '音乐总监',
  '音樂總監',
  '出品人',
  '出品方',
  '出品',
  '联合出品',
  '聯合出品',
  '联合赞助',
  '聯合贊助',
  '联合发行',
  '聯合發行',
  '歌曲联合发行',
  '歌曲聯合發行',
  '歌曲发行',
  '歌曲發行',
  '联合制作',
  '聯合製作',
  '制作发行',
  '製作發行',
  '出品发行',
  '出品發行',
  '发行方',
  '發行方',
  '制作方',
  '製作方',
  '版权方',
  '版權方',
  '版权提供',
  '版權提供',
  '版权声明',
  '版權聲明',
  '音乐制作',
  '音樂製作',
  '音乐出品',
  '音樂出品',
  '音乐发行',
  '音樂發行',
  '音乐版权',
  '音樂版權',
  '词曲版权',
  '詞曲版權',
  '制作名单',
  '製作名單',
  'LRC制作',
  'LRC製作',
  '歌词制作',
  '歌詞製作',
  '时间轴',
  '時間軸',
  '翻译',
  '翻譯',
  '译者',
  '譯者',
  '校对',
  '校對',
  '歌词',
  '歌詞',
  'LRC',
  '人声',
  '人聲',
  '配器',
  '混音工程师',
  '混音工程師',
  '母带工程师',
  '母帶工程師',
  '录音工程师',
  '錄音工程師',
  '出品公司',
  '制作公司',
  '製作公司',
  '视觉',
  '視覺',
  '视觉设计',
  '視覺設計',
  '插画',
  '插畫',
  '插画师',
  '插畫師',
  '摄影',
  '攝影',
  '摄影指导',
  '攝影指導',
  '和音',
  '配唱',
  '发行公司',
  '發行公司',
  '发行',
  '發行',
  '唱片公司',
  '厂牌',
  '廠牌',
  '经纪公司',
  '經紀公司',
  '企划',
  '企劃',
  '统筹',
  '統籌',
  '商务',
  '商務',
  '商务统筹',
  '商務統籌',
  '商务经纪',
  '商務經紀',
  '商务合作',
  '商務合作',
  '商务企划',
  '商務企劃',
  '商务宣传',
  '商務宣傳',
  '商务联系',
  '商務聯繫',
  '商务对接',
  '商務對接',
  '商务运营',
  '商務運營',
  '宣发',
  '宣發',
  '企宣',
  '策划',
  '策劃',
  '宣传',
  '宣傳',
  '推广',
  '推廣',
  '文案',
  '设计',
  '設計',
  '平面设计',
  '平面設計',
  '封面设计',
  '封面設計',
  'MV导演',
  'MV導演',
  '导演',
  '導演',
  // 录音 / 后期
  '录音室',
  '錄音室',
  '录音棚',
  '錄音棚',
  '录音师',
  '錄音師',
  '录音',
  '錄音',
  '人声录音',
  '人聲錄音',
  '配唱制作人',
  '配唱製作人',
  '混音师',
  '混音師',
  '混音室',
  '混音棚',
  '混音',
  '母带',
  '母帶',
  '后期制作',
  '後期製作',
  '后期',
  '後期',
  '音频编辑',
  '音頻編輯',
  '调教',
  '調教',
  '人声调教',
  '人聲調教',
  'Vocaloid调教',
  'V家调教',
  '调校',
  '調校',
  '调音',
  '調音',
  '调音师',
  '調音師',
  // 乐手 / 和声
  '和声编写',
  '和聲編寫',
  '弦乐编写',
  '弦樂編寫',
  '弦乐监制',
  '弦樂監製',
  '弦乐制作',
  '弦樂製作',
  '弦乐录音',
  '弦樂錄音',
  '弦乐演奏',
  '弦樂演奏',
  '和声',
  '和聲',
  '合声',
  '合聲',
  '伴唱',
  '合唱',
  '吉他',
  '吉他手',
  '贝斯',
  '貝斯',
  '贝斯手',
  '貝斯手',
  '鼓手',
  '鼓',
  '键盘手',
  '鍵盤手',
  '钢琴手',
  '鋼琴手',
  '小提琴手',
  '中提琴手',
  '大提琴手',
  '低音提琴手',
  '萨克斯手',
  '薩克斯手',
  '小号手',
  '小號手',
  '长号手',
  '長號手',
  '长笛手',
  '長笛手',
  '手风琴手',
  '手風琴手',
  '口琴手',
  '打击乐手',
  '打擊樂手',
  '键盘',
  '鍵盤',
  '钢琴',
  '鋼琴',
  '弦乐',
  '弦樂',
  '小提琴',
  '大提琴',
  '口琴',
  '萨克斯',
  '薩克斯',
  '笛子',
  '二胡',
  '古筝',
  '古箏',
  '琵琶',
  '中提琴',
  '低音提琴',
  '倍低音提琴',
  '竖琴',
  '長號',
  '长号',
  '小号',
  '小號',
  '长笛',
  '長笛',
  '双簧管',
  '雙簧管',
  '单簧管',
  '單簧管',
  '大管',
  '巴松',
  '圆号',
  '圓號',
  '大号',
  '大號',
  '手风琴',
  '手風琴',
  '陶笛',
  '排箫',
  '排簫',
  '笙',
  '箫',
  '簫',
  '唢呐',
  '嗩吶',
  '柳琴',
  '月琴',
  '阮',
  '三弦',
  '扬琴',
  '马头琴',
  '馬頭琴',
  '冬不拉',
  '定音鼓',
  '架子鼓',
  '爵士鼓',
  '手鼓',
  '沙锤',
  '沙錘',
  '三角铁',
  '三角鐵',
  '打击乐',
  '打擊樂',
  '管乐',
  '管樂',
  '铜管',
  '銅管',
  '木管',
  '木管乐',
  '木管樂',
  '铜管乐',
  '銅管樂',
  '乐队',
  '樂隊',
  '乐团',
  '樂團',
  '管弦乐团',
  '管弦樂團',
  '合唱团',
  '合唱團',
  '童声',
  '童聲',
  '念白',
  '旁白',
  '指挥',
  '指揮',
  '乐器',
  '樂器',
  '演奏',
  '演唱',
  '歌手',
  '原唱',
  '主唱',
  '领唱',
  '領唱',
  '监唱',
  '和声演唱',
  '和聲演唱',
  '和声编唱',
  '和聲編唱',
  '和音演唱',
  '和音编唱',
  '和音編唱',
  '对唱',
  '對唱',
  '解说',
  '解說',
  '朗诵',
  '朗誦',
  '播音',
  '主持',
  '司仪',
  '司儀',
  '说唱',
  '說唱',
  'Rap',
  'Rap词',
  'Rap詞',
  'Rap演唱',
  '配唱制作',
  '配唱製作',
  // 歌曲信息 / 版权 / 赞助
  '歌名',
  '歌曲名',
  '专辑',
  '專輯',
  '专辑名',
  '專輯名',
  '词',
  '詞',
  '曲',
  'OP',
  'SP',
  '版权',
  '版權',
  '著作权',
  '著作權',
  '版权所有',
  '版權所有',
  '未经许可',
  '未經許可',
  '未经授权',
  '未經授權',
  '赞助商',
  '贊助商',
  '赞助',
  '贊助',
  '鸣谢',
  '鳴謝',
  '特别鸣谢',
  '特別鳴謝',
  // 日文常见
  'プロデュース',
  'プロデューサー',
  'アレンジ',
  'ミックス',
  'マスタリング',
  'レコーディング',
  'ギター',
  'ベース',
  'ドラム',
  'キーボード',
  'ピアノ',
  'コーラス',
  'エンジニア',
  '発売',
  '販売',
  '著作権',
  '転載禁止',
  // 韩文常见
  '작사',
  '작곡',
  '편곡',
  '프로듀서',
  '믹스',
  '마스터링',
  '기타',
  '베이스',
  '드럼',
  '키보드',
  '피아노',
  '코러스',
  // 制作人 / 发行商 / 版权 / 宣传 / 歌词贡献扩展（含简繁）
  '总制作人',
  '總製作人',
  '执行制作人',
  '執行製作人',
  '联合制作人',
  '聯合製作人',
  '副制作人',
  '副製作人',
  '助理制作人',
  '助理製作人',
  '主制作人',
  '主製作人',
  '音乐制作人',
  '音樂製作人',
  '歌曲制作人',
  '歌曲製作人',
  '单曲制作人',
  '單曲製作人',
  '专辑制作人',
  '專輯製作人',
  '项目制作人',
  '項目製作人',
  '人声制作人',
  '人聲製作人',
  '声乐制作人',
  '聲樂製作人',
  '音频制作人',
  '音頻製作人',
  '混音制作人',
  '混音製作人',
  '母带制作人',
  '母帶製作人',
  '编曲制作人',
  '編曲製作人',
  '说唱制作人',
  '說唱製作人',
  '后期制作人',
  '後期製作人',
  '特邀制作人',
  '特邀製作人',
  '客座制作人',
  '客座製作人',
  '制作总监',
  '製作總監',
  '制作统筹',
  '製作統籌',
  '制作团队',
  '製作團隊',
  '制作助理',
  '製作助理',
  '制作人员',
  '製作人員',
  '制作单位',
  '製作單位',
  '制作机构',
  '製作機構',
  '制作商',
  '製作商',
  '制作协力',
  '製作協力',
  '制作协助',
  '製作協助',
  '协助制作',
  '協助製作',
  '特约制作',
  '特約製作',
  '委托制作',
  '委託製作',
  '制作发行方',
  '製作發行方',
  '制作出品',
  '製作出品',
  '歌曲制作',
  '歌曲製作',
  '专辑制作',
  '專輯製作',
  '单曲制作',
  '單曲製作',
  '制片人',
  '製片人',
  '总制片人',
  '總製片人',
  '执行制片',
  '執行製片',
  '总制片',
  '總製片',
  '制片',
  '製片',
  '出品制作',
  '出品製作',
  '出品制作人',
  '出品製作人',
  '发行商',
  '發行商',
  '发行人',
  '發行人',
  '发行机构',
  '發行機構',
  '发行单位',
  '發行單位',
  '发行团队',
  '發行團隊',
  '发行部门',
  '發行部門',
  '发行厂牌',
  '發行廠牌',
  '发行代理',
  '發行代理',
  '发行品牌',
  '發行品牌',
  '发行统筹',
  '發行統籌',
  '发行企划',
  '發行企劃',
  '发行运营',
  '發行運營',
  '发行支持',
  '發行支持',
  '发行制作',
  '發行製作',
  '发行平台',
  '發行平台',
  '数字发行',
  '數字發行',
  '数字发行商',
  '數字發行商',
  '数字音乐发行',
  '數字音樂發行',
  '全网发行',
  '全網發行',
  '全网数字发行',
  '全網數字發行',
  '全平台发行',
  '全平台發行',
  '独家发行',
  '獨家發行',
  '独家发行商',
  '獨家發行商',
  '联合发行商',
  '聯合發行商',
  '海外发行',
  '海外發行',
  '海外发行商',
  '海外發行商',
  '海外数字发行',
  '海外數字發行',
  '全球发行',
  '全球發行',
  '全球发行商',
  '全球發行商',
  '代理发行',
  '代理發行',
  '版权发行',
  '版權發行',
  '版权发行商',
  '版權發行商',
  '实体唱片发行',
  '實體唱片發行',
  '唱片发行',
  '唱片發行',
  '发行时间',
  '發行時間',
  '发行日期',
  '發行日期',
  '发行年份',
  '發行年份',
  '发行地区',
  '發行地區',
  '发行版本',
  '發行版本',
  '出品商',
  '出品单位',
  '出品單位',
  '出品机构',
  '出品機構',
  '出品团队',
  '出品團隊',
  '出品厂牌',
  '出品廠牌',
  '出品时间',
  '出品時間',
  '联合出品人',
  '聯合出品人',
  '联合出品方',
  '聯合出品方',
  '承制',
  '承製',
  '承制方',
  '承製方',
  '出版',
  '出版商',
  '出版方',
  '出版社',
  '出版公司',
  '出版单位',
  '出版單位',
  '出版发行',
  '出版發行',
  '出版时间',
  '出版時間',
  '所属厂牌',
  '所屬廠牌',
  '制作厂牌',
  '製作廠牌',
  '音乐厂牌',
  '音樂廠牌',
  '联合厂牌',
  '聯合廠牌',
  '厂牌主理人',
  '廠牌主理人',
  '主理人',
  '版权商',
  '版權商',
  '版权公司',
  '版權公司',
  '版权代理',
  '版權代理',
  '版权归属',
  '版權歸屬',
  '版权所属',
  '版權所屬',
  '版权管理',
  '版權管理',
  '版权管理方',
  '版權管理方',
  '版权运营',
  '版權運營',
  '版权授权',
  '版權授權',
  '正版授权',
  '正版授權',
  '授权方',
  '授權方',
  '被授权方',
  '被授權方',
  '海外版权',
  '海外版權',
  '全球版权',
  '全球版權',
  '独家版权',
  '獨家版權',
  '词版权',
  '詞版權',
  '曲版权',
  '曲版權',
  '母带版权',
  '母帶版權',
  '录音版权',
  '錄音版權',
  '词OP',
  '詞OP',
  '曲OP',
  '词SP',
  '詞SP',
  '曲SP',
  '著作权人',
  '著作權人',
  '权利人',
  '權利人',
  '总监制',
  '總監製',
  '联合监制',
  '聯合監製',
  '总策划',
  '總策劃',
  '总统筹',
  '總統籌',
  '项目总监',
  '項目總監',
  '项目统筹',
  '項目統籌',
  '音乐统筹',
  '音樂統籌',
  '艺宣',
  '藝宣',
  '艺人统筹',
  '藝人統籌',
  '艺人宣传',
  '藝人宣傳',
  '宣发团队',
  '宣發團隊',
  '宣发策划',
  '宣發策劃',
  '推广公司',
  '推廣公司',
  '营销公司',
  '營銷公司',
  '宣传公司',
  '宣傳公司',
  '推广发行',
  '推廣發行',
  '企划制作',
  '企劃製作',
  '企划发行',
  '企劃發行',
  '企划宣传',
  '企劃宣傳',
  '企划统筹',
  '企劃統籌',
  '宣传发行',
  '宣傳發行',
  '运营发行',
  '運營發行',
  '营销',
  '營銷',
  '媒体推广',
  '媒體推廣',
  '新媒体推广',
  '新媒體推廣',
  '短视频推广',
  '短視頻推廣',
  '合作联系',
  '合作聯繫',
  '合作邮箱',
  '合作郵箱',
  '联系邮箱',
  '聯繫郵箱',
  '商务授权',
  '商務授權',
  '商业授权',
  '商業授權',
  '原曲',
  '原词',
  '原詞',
  '原版',
  '词作者',
  '詞作者',
  '曲作者',
  '原作者',
  '所属专辑',
  '所屬專輯',
  '专辑名称',
  '專輯名稱',
  '歌曲名称',
  '歌曲名稱',
  '歌词编辑',
  '歌詞編輯',
  '滚动歌词',
  '滾動歌詞',
  '滚动歌词制作',
  '滾動歌詞製作',
  '动态歌词',
  '動態歌詞',
  '动态歌词制作',
  '動態歌詞製作',
  '逐字歌词',
  '逐字歌詞',
  '歌词校正',
  '歌詞校正',
  '歌词校对',
  '歌詞校對',
  '歌词整理',
  '歌詞整理',
  '歌词统筹',
  '歌詞統籌',
  '歌词提供',
  '歌詞提供',
  '歌词提供者',
  '歌詞提供者',
  '文本提供',
  '提供歌词',
  '提供歌詞',
  '歌词搬运',
  '歌詞搬運',
  '歌词上传',
  '歌詞上傳',
  '歌词审核',
  '歌詞審核',
  '歌词翻译',
  '歌詞翻譯',
  '歌词校译',
  '歌詞校譯',
  '歌词贡献',
  '歌詞貢獻',
  '翻译贡献',
  '翻譯貢獻',
  '贡献者',
  '貢獻者',
  '上传者',
  '上傳者',
  '打轴',
  '打軸',
  '字幕',
  '字幕组',
  '字幕組',
  '字幕制作',
  '字幕製作',
  '后期编辑',
  '後期編輯',
  '词曲编',
  '詞曲編',
  '词曲唱',
  '詞曲唱',
  '词曲编唱',
  '詞曲編唱',
  '编混',
  '編混',
  '录混',
  '錄混',
  '音乐版权顾问',
  '音樂版權顧問',
  '版权顾问',
  '版權顧問',
  '创意顾问',
  '創意顧問',
  '艺术顾问',
  '藝術顧問',
  '音乐顾问',
  '音樂顧問',
  '技术顾问',
  '技術顧問',
  '法律顾问',
  '法律顧問',
  '合声编写',
  '合聲編寫',
  '和声设计',
  '和聲設計',
  '合声设计',
  '合聲設計',
  'MV团队',
  'MV團隊',
  '工作团队',
  '工作團隊',
  '宣传营销',
  '宣傳營銷',
  '协办单位',
  '協辦單位',
  '主办单位',
  '主辦單位',
  '承办单位',
  '承辦單位',
  '指导单位',
  '指導單位',
  '支持单位',
  '支持單位',
];

const EN_LABELS = [
  // 制作 / 词曲
  'executive producer',
  'co-producer',
  'assistant producer',
  'associate producer',
  'additional producer',
  'vocal producer',
  'music producer',
  'recording engineer',
  'mixing engineer',
  'mastering engineer',
  'mix engineer',
  'production coordination',
  'production coordinator',
  'production manager',
  'coordinator',
  'background vocals',
  'backing vocals',
  'lead vocals',
  'vocal tuning',
  'tuning',
  'tuned',
  'vocal arrangement',
  'string arrangement',
  'arrangement',
  'programming',
  'programmed',
  'programmer',
  'synthesizer',
  'synth',
  'percussion',
  'violin',
  'viola',
  'cello',
  'double bass',
  'contrabass',
  'flute',
  'oboe',
  'clarinet',
  'bassoon',
  'saxophone',
  'trumpet',
  'trombone',
  'french horn',
  'horn',
  'tuba',
  'timpani',
  'harmonica',
  'harp',
  'organ',
  'mandolin',
  'banjo',
  'ukulele',
  'electric guitar',
  'acoustic guitar',
  'bass guitar',
  'electric bass',
  'lead guitar',
  'rhythm guitar',
  'brass',
  'woodwind',
  'woodwinds',
  'choir',
  'chorus',
  'producer',
  'produced',
  'composer',
  'composed',
  'songwriter',
  'lyricist',
  'lyrics',
  'lyric',
  'translation',
  'translator',
  'translated',
  'proofread',
  'proofreading',
  'synced',
  'submitted',
  'uploaded',
  'timing',
  'timestamps',
  'lyrics editor',
  'editor',
  'arranger',
  'arranged',
  'written',
  'writer',
  'words',
  'music',
  'melody',
  // 人声 / 乐手 / 后期
  'vocals',
  'vocal',
  'performer',
  'performed',
  'singer',
  'artist',
  'mixed',
  'mixing',
  'mastered',
  'mastering',
  'recorded',
  'recording',
  'engineer',
  'engineered',
  'guitar',
  'bass',
  'drums',
  'drum',
  'keyboards',
  'keyboard',
  'piano',
  'strings',
  'conductor',
  'conducted',
  'conducting',
  'orchestra',
  // 发行 / 版权 / 其他
  'publisher',
  'publishing',
  'label',
  'management',
  'manager',
  'business',
  'marketing',
  'publicity',
  'promotion',
  'a&r',
  'design',
  'artwork',
  'art direction',
  'photography',
  'photographer',
  'illustration',
  'illustrator',
  'cover art',
  'cover design',
  'graphic design',
  'liner notes',
  'staff',
  'credits',
  'credit',
  'director',
  'sponsor',
  'sponsored',
  'thanks',
  'special thanks',
  'copyright',
  'song',
  'title',
  'album',
  'phonographic copyright',
  'published',
  'publishers',
  'co-published',
  'sub-publisher',
  'administered',
  'distributed',
  'distributor',
  'distributors',
  'distribution',
  'released',
  'release',
  'release date',
  'production',
  'producers',
  'co-produced',
  'co-written',
  'co-arranged',
  'co-executive producer',
  'line producer',
  'songwriters',
  'composers',
  'lyricists',
  'arrangers',
  'musicians',
  'vocalists',
  'singers',
  'writers',
  'lrc',
  'a & r',
  'a&r direction',
  'a&r coordinator',
  'a&r administration',
  'album art',
  'public relations',
  'pr',
  'licensed',
  'license',
  'repertoire owner',
  'manufacturing company',
  'production company',
  'publishing company',
  'record company',
  'management company',
];

// 带冒号的 credits 常常是「前缀 + 冒号 + 名单」，前缀会套很多层修饰
// （人声录音师、母带后期处理录音室、宣传物料及黑胶设计…）。
// 与其穷举每一种组合，不如只看冒号前最后一个词是不是制作/版权类名词；
// 这样「制作一个梦：…」这种歌词不会被误判（结尾是「梦」而不是「制作」）。
const CN_SUFFIXES = [
  // 词曲 / 制作 / 发行
  '制作',
  '製作',
  '制作人',
  '製作人',
  '制作团队',
  '製作團隊',
  '制作公司',
  '製作公司',
  '制作助理',
  '製作助理',
  '制作总监',
  '製作總監',
  '编曲',
  '編曲',
  '作词',
  '作詞',
  '作词人',
  '作詞人',
  '作曲',
  '作曲人',
  '词曲',
  '詞曲',
  '填词',
  '填詞',
  '粤语填词',
  '粵語填詞',
  '原词',
  '原詞',
  '监制',
  '監製',
  '总监制',
  '總監製',
  '总监',
  '總監',
  '出品',
  '出品人',
  '出品方',
  '出品公司',
  '出品发行',
  '出品發行',
  '发行',
  '發行',
  '发行人',
  '發行人',
  '发行方',
  '發行方',
  '发行公司',
  '發行公司',
  '联合出品',
  '聯合出品',
  '联合发行',
  '聯合發行',
  '版权',
  '版權',
  '版权方',
  '版權方',
  '著作权',
  '著作權',
  '版权管理',
  '版權管理',
  '版权管理方',
  '版權管理方',
  '词曲版权',
  '詞曲版權',
  '词曲提供',
  '詞曲提供',
  '词曲OP',
  '詞曲OP',
  'OP',
  'SP',
  '厂牌',
  '廠牌',
  '唱片公司',
  '经纪公司',
  '經紀公司',
  // 录音 / 后期
  '录音',
  '錄音',
  '录音师',
  '錄音師',
  '录音室',
  '錄音室',
  '录音棚',
  '錄音棚',
  '录音助理',
  '錄音助理',
  '录音工作室',
  '錄音工作室',
  '录音制作',
  '錄音製作',
  '人声录音师',
  '人聲錄音師',
  '人声录音室',
  '人聲錄音室',
  '人声录音棚',
  '人聲錄音棚',
  '主唱录音师',
  '主唱錄音師',
  '主唱录音棚',
  '主唱錄音棚',
  '鼓录音师',
  '鼓錄音師',
  '乐器录音师',
  '樂器錄音師',
  '弦乐录音师',
  '弦樂錄音師',
  '弦乐录音室',
  '弦樂錄音室',
  '录制',
  '錄製',
  '人声录制',
  '人聲錄製',
  '录制混缩',
  '錄製混縮',
  '混缩',
  '混縮',
  '缩混',
  '縮混',
  '混音',
  '混音师',
  '混音師',
  '混音室',
  '混音棚',
  '混音工作室',
  '混音录音室',
  '混音母带',
  '混音工程师',
  '混音工程師',
  '分轨混音',
  '分軌混音',
  '母带',
  '母帶',
  '母带师',
  '母帶師',
  '母带室',
  '母帶室',
  '母带工程师',
  '母帶工程師',
  '母带制作',
  '母帶製作',
  '母带处理',
  '母帶處理',
  '母带后期',
  '母帶後期',
  '后期',
  '後期',
  '后期制作',
  '後期製作',
  '助理',
  '工程师',
  '工程師',
  '工程',
  // 人声 / 和声 / 乐手
  '人声',
  '人聲',
  '人声编辑',
  '人聲編輯',
  '人声监制',
  '人聲監製',
  '人声指导',
  '人聲指導',
  '配唱',
  '配唱制作',
  '配唱製作',
  '配唱编写',
  '配唱編寫',
  '配唱制作人',
  '配唱製作人',
  '主唱',
  '主唱编辑',
  '主唱編輯',
  '领唱',
  '領唱',
  '监唱',
  '和声演唱',
  '和聲演唱',
  '和声编唱',
  '和聲編唱',
  '和音演唱',
  '和音编唱',
  '和音編唱',
  '对唱',
  '對唱',
  '解说',
  '解說',
  '朗诵',
  '朗誦',
  '播音',
  '主持',
  '司仪',
  '司儀',
  '伴唱',
  '和声',
  '和聲',
  '合声',
  '合聲',
  '合音',
  '和音',
  '和声编写',
  '和聲編寫',
  '和声编录',
  '和聲編錄',
  '合音制作',
  '合音製作',
  '独奏',
  '獨奏',
  '指挥',
  '指揮',
  '念白',
  '旁白',
  '昆曲念白',
  '崑曲念白',
  '女声',
  '女聲',
  '男声',
  '男聲',
  '旦角',
  '器乐',
  '器樂',
  '乐器',
  '樂器',
  '器乐录音',
  '器樂錄音',
  '乐器录音',
  '樂器錄音',
  '弦乐',
  '弦樂',
  '弦乐团',
  '弦樂團',
  '弦乐编写',
  '弦樂編寫',
  '弦乐录音',
  '弦樂錄音',
  '弦乐四重奏',
  '弦樂四重奏',
  '管乐',
  '管樂',
  '铜管',
  '銅管',
  '木管',
  '木管乐',
  '木管樂',
  '打击乐',
  '打擊樂',
  '乐队',
  '樂隊',
  '乐团',
  '樂團',
  '管弦乐团',
  '管弦樂團',
  '合唱团',
  '合唱團',
  '合唱',
  '童声',
  '童聲',
  '吉他',
  '吉他手',
  '电吉他',
  '電吉他',
  '木吉他',
  '低音吉他',
  '贝斯',
  '貝斯',
  '贝斯手',
  '貝斯手',
  '鼓',
  '鼓手',
  '键盘',
  '鍵盤',
  '键盘手',
  '鍵盤手',
  '钢琴',
  '鋼琴',
  '钢琴手',
  '鋼琴手',
  '提琴',
  '小提琴',
  '小提琴手',
  '中提琴',
  '中提琴手',
  '大提琴',
  '大提琴手',
  '低音提琴',
  '低音提琴手',
  '倍低音提琴',
  '竖琴',
  '笛',
  '笛子',
  '中国笛',
  '中國笛',
  '箫',
  '簫',
  '萧',
  '蕭',
  '萨克斯',
  '薩克斯',
  '萨克斯手',
  '薩克斯手',
  '小号',
  '小號',
  '小号手',
  '小號手',
  '长号',
  '長號',
  '长号手',
  '長號手',
  '长笛',
  '長笛',
  '长笛手',
  '長笛手',
  '短笛',
  '双簧管',
  '雙簧管',
  '单簧管',
  '單簧管',
  '大管',
  '巴松',
  '圆号',
  '圓號',
  '大号',
  '大號',
  '手风琴',
  '手風琴',
  '手风琴手',
  '手風琴手',
  '口琴',
  '口琴手',
  '陶笛',
  '排箫',
  '排簫',
  '笙',
  '唢呐',
  '嗩吶',
  '柳琴',
  '月琴',
  '阮',
  '三弦',
  '扬琴',
  '马头琴',
  '馬頭琴',
  '冬不拉',
  '定音鼓',
  '架子鼓',
  '爵士鼓',
  '手鼓',
  '沙锤',
  '沙錘',
  '三角铁',
  '三角鐵',
  // 宣传 / 统筹 / 艺人
  '统筹',
  '統籌',
  '企划',
  '企劃',
  '策划',
  '策劃',
  '宣传',
  '宣傳',
  '推广',
  '推廣',
  '营销',
  '營銷',
  '行销',
  '行銷',
  '宣发',
  '宣發',
  '商务',
  '商務',
  '业务',
  '業務',
  '聯繫',
  '艺人',
  '藝人',
  '经纪',
  '經紀',
  '经纪人',
  '經紀人',
  '协力',
  '協力',
  '項目',
  '运营',
  '運營',
  '运营官',
  '運營官',
  '媒介',
  '小程序',
  '试唱小程序',
  '試唱小程序',
  '合作伙伴',
  '合作夥伴',
  '伙伴',
  '夥伴',
  '特别感谢',
  '特別感謝',
  '感謝',
  '鸣谢',
  '鳴謝',
  '赞助',
  '贊助',
  '主办',
  '主辦',
  '承办',
  '承辦',
  '协办',
  '協辦',
  '场地',
  '場地',
  '技术支持',
  '技術支持',
  '敬告',
  '承制',
  '执行',
  '執行',
  '制片',
  '製片',
  '制片人',
  '製片人',
  '执行制片',
  '執行製片',
  // 视觉 / 设计 / 影视
  '封面',
  '封面设计',
  '封面設計',
  '海报',
  '海報',
  '海报设计',
  '海報設計',
  '海报设计团队',
  '海報設計團隊',
  '题字',
  '題字',
  '字体',
  '字體',
  '书法',
  '書法',
  '設計',
  '平面设计',
  '平面設計',
  '视觉设计',
  '視覺設計',
  '插画',
  '插畫',
  '插画师',
  '插畫師',
  '视觉插画',
  '視覺插畫',
  '曲绘',
  '曲繪',
  '视觉',
  '視覺',
  '攝影',
  '摄影师',
  '攝影師',
  '平面摄影师',
  '平面攝影師',
  '拍摄',
  '拍攝',
  '花絮',
  '花絮拍摄',
  '花絮拍攝',
  '导演',
  '導演',
  '剪辑',
  '剪輯',
  '调色',
  '調色',
  '动画',
  '動畫',
  '特效',
  '美术',
  '美術',
  '美工',
  '造型',
  '服装',
  '服裝',
  '妆发',
  '妝髮',
  '道具师',
  '道具師',
  '燈光',
  '灯光师',
  '燈光師',
  '编剧',
  '編劇',
  '原著',
  '合成',
  '采样',
  '採樣',
  '音效',
  '音效师',
  '音效師',
  '配音',
  '配乐',
  '配樂',
  '配乐师',
  '配樂師',
  '團隊',
  '设计团队',
  '設計團隊',
  '宣传物料',
  '宣傳物料',
  '黑胶设计',
  '黑膠設計',
  '音乐制作',
  '音樂製作',
  '音乐监制',
  '音樂監製',
  '音乐统筹',
  '音樂統籌',
  '音乐发行',
  '音樂發行',
  '音乐出品',
  '音樂出品',
  '音乐营销',
  '音樂營銷',
  '音乐制作人',
  '音樂製作人',
  '版权商务',
  '版權商務',
  '宣发合作伙伴',
  '宣發合作夥伴',
  '策略行销',
  '策略行銷',
  '营销策划',
  '營銷策劃',
  '营销推广',
  '營銷推廣',
  '推广策划',
  '推廣策劃',
  '宣发策划',
  '宣發策劃',
  '项目支持',
  '項目支持',
  '原创',
  '原創',
  '联合推广',
  '聯合推廣',
  'OP',
  'SP',
  'PV',
  'MIDI',
  'MIDI工程',
  'Remix',
  'LRC',
  '音乐出品发行公司',
  '独家短视频平台',
  '黑胶设计',
  '资产管理',
  '版权管理',
  '词曲版权管理',
  '技术支持',
  '项目支持',
  '场地支持',
  '业务联系',
  '商务联系',
  '声乐指导',
  '戏曲指导',
  '歌唱指导',
  '艺术指导',
  '美术指导',
  '舞蹈指导',
  '表演指导',
  '和音编写',
  '设计团队',
  '海报设计团队',
  '制作商',
  '製作商',
  '制作单位',
  '製作單位',
  '制作机构',
  '製作機構',
  '制作人员',
  '製作人員',
  '制作协力',
  '製作協力',
  '制作协助',
  '製作協助',
  '发行商',
  '發行商',
  '发行机构',
  '發行機構',
  '发行单位',
  '發行單位',
  '发行团队',
  '發行團隊',
  '发行部门',
  '發行部門',
  '发行厂牌',
  '發行廠牌',
  '发行代理',
  '發行代理',
  '发行品牌',
  '發行品牌',
  '发行统筹',
  '發行統籌',
  '发行企划',
  '發行企劃',
  '发行运营',
  '發行運營',
  '发行支持',
  '發行支持',
  '发行制作',
  '發行製作',
  '发行平台',
  '發行平台',
  '数字发行',
  '數字發行',
  '数字发行商',
  '數字發行商',
  '联合发行商',
  '聯合發行商',
  '独家发行商',
  '獨家發行商',
  '海外发行商',
  '海外發行商',
  '全球发行商',
  '全球發行商',
  '版权发行',
  '版權發行',
  '版权发行商',
  '版權發行商',
  '发行时间',
  '發行時間',
  '发行日期',
  '發行日期',
  '发行年份',
  '發行年份',
  '发行地区',
  '發行地區',
  '发行版本',
  '發行版本',
  '出品商',
  '出品单位',
  '出品單位',
  '出品机构',
  '出品機構',
  '出品团队',
  '出品團隊',
  '出品厂牌',
  '出品廠牌',
  '出品时间',
  '出品時間',
  '承制',
  '承製',
  '承制方',
  '承製方',
  '版权商',
  '版權商',
  '版权公司',
  '版權公司',
  '版权代理',
  '版權代理',
  '版权归属',
  '版權歸屬',
  '版权所属',
  '版權所屬',
  '版权运营',
  '版權運營',
  '版权授权',
  '版權授權',
  '正版授权',
  '正版授權',
  '授权方',
  '授權方',
  '被授权方',
  '被授權方',
  '出版',
  '出版商',
  '出版方',
  '出版社',
  '出版公司',
  '出版单位',
  '出版單位',
  '出版发行',
  '出版發行',
  '出版时间',
  '出版時間',
  '主理人',
  '推广公司',
  '推廣公司',
  '营销公司',
  '營銷公司',
  '宣传公司',
  '宣傳公司',
  '宣发团队',
  '宣發團隊',
  '词作者',
  '詞作者',
  '曲作者',
  '原作者',
  '原曲',
  '原词',
  '原詞',
  '合作邮箱',
  '合作郵箱',
  '联系邮箱',
  '聯繫郵箱',
  '合作联系',
  '合作聯繫',
  '歌词编辑',
  '歌詞編輯',
  '滚动歌词',
  '滾動歌詞',
  '滚动歌词制作',
  '滾動歌詞製作',
  '动态歌词',
  '動態歌詞',
  '动态歌词制作',
  '動態歌詞製作',
  '逐字歌词',
  '逐字歌詞',
  '歌词制作',
  '歌詞製作',
  '歌词校正',
  '歌詞校正',
  '歌词校对',
  '歌詞校對',
  '歌词整理',
  '歌詞整理',
  '歌词统筹',
  '歌詞統籌',
  '歌词提供',
  '歌詞提供',
  '歌词提供者',
  '歌詞提供者',
  '文本提供',
  '提供歌词',
  '提供歌詞',
  '歌词搬运',
  '歌詞搬運',
  '歌词上传',
  '歌詞上傳',
  '歌词审核',
  '歌詞審核',
  '歌词翻译',
  '歌詞翻譯',
  '歌词校译',
  '歌詞校譯',
  '歌词贡献',
  '歌詞貢獻',
  '翻译贡献',
  '翻譯貢獻',
  '贡献者',
  '貢獻者',
  '上传者',
  '上傳者',
  '提供者',
  '打轴',
  '打軸',
  '字幕组',
  '字幕組',
  '字幕制作',
  '字幕製作',
  '后期编辑',
  '後期編輯',
  '词曲编',
  '詞曲編',
  '词曲唱',
  '詞曲唱',
  '词曲编唱',
  '詞曲編唱',
  '编混',
  '編混',
  '录混',
  '錄混',
  '专辑名称',
  '專輯名稱',
  '歌曲名称',
  '歌曲名稱',
  '所属专辑',
  '所屬專輯',
  '著作权人',
  '著作權人',
  '权利人',
  '權利人',
  '顾问',
  '顧問',
  '有限公司',
  '有限责任公司',
  '有限責任公司',
  '股份有限公司',
  '股份公司',
  '团队',
  '单位',
  '营销',
  '合声编写',
  '合聲編寫',
  '和声设计',
  '和聲設計',
  '合声设计',
  '合聲設計',
  '协办单位',
  '協辦單位',
  '工作团队',
  '工作團隊',
  '宣传营销',
  '宣傳營銷',
];

const EN_SUFFIXES = [
  'producer',
  'produced',
  'production',
  'composer',
  'composed',
  'lyricist',
  'lyrics',
  'lyric',
  'arranger',
  'arrangement',
  'arranged',
  'written',
  'writer',
  'songwriter',
  'lyrics editor',
  'editor',
  'vocals',
  'vocal',
  'vocalist',
  'singer',
  'performer',
  'performed',
  'mixed',
  'mixing',
  'mix',
  'mastered',
  'mastering',
  'recorded',
  'recording',
  'engineer',
  'engineered',
  'guitar',
  'bass',
  'double bass',
  'contrabass',
  'drums',
  'drum',
  'keyboards',
  'keyboard',
  'piano',
  'strings',
  'violin',
  'viola',
  'cello',
  'conductor',
  'conducted',
  'orchestra',
  'choir',
  'chorus',
  'publisher',
  'publishing',
  'label',
  'management',
  'manager',
  'business',
  'marketing',
  'publicity',
  'promotion',
  'staff',
  'credits',
  'credit',
  'design',
  'artwork',
  'art direction',
  'photography',
  'photographer',
  'illustration',
  'illustrator',
  'director',
  'sponsor',
  'sponsored',
  'thanks',
  'special thanks',
  'music',
  'studio',
  'solo',
  'edite',
  'produce',
  'remix',
  'midi',
  'pv',
  'planning',
  'coordination',
  'co ordination',
  'ordination',
  'produced by',
  'mixed by',
  'mastered by',
  'recorded by',
  'engineered by',
  'arranged by',
  'written by',
  'composed by',
  'lyrics by',
  'music by',
  'executive produced by',
  'vocal production',
  'vocal edit',
  'vocal editing',
  'string arrangement',
  'string writing',
  'first violin',
  'second violin',
  'solo cello',
  'cello solo',
  'solo cello arrangement',
  'backing vocals',
  'backing vocal',
  'lead vocals',
  'lead vocal',
  'background vocals',
  'background vocal',
  'vocal tuning',
  'tuned',
  'tuning',
  'publishers',
  'published',
  'published by',
  'distributed',
  'distributor',
  'distributors',
  'distribution',
  'distributed by',
  'released',
  'release',
  'released by',
  'release date',
  'producers',
  'songwriters',
  'composers',
  'lyricists',
  'arrangers',
  'writers',
  'vocalists',
  'singers',
  'musicians',
  'a&r',
  'a & r',
  'phonographic copyright',
  'copyright',
  'licensed',
  'licensed by',
  'album art',
  'cover art',
  'cover design',
  'public relations',
  'administration',
  'administered',
  'administered by',
  'lrc',
  'repertoire owner',
  'manufacturing company',
  'production company',
  'publishing company',
  'record company',
  'management company',
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniqueLongestFirst = (labels) =>
  [...new Set(labels)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

const CN_PATTERN = uniqueLongestFirst(CN_LABELS);
const EN_PATTERN = uniqueLongestFirst(EN_LABELS);

// 冒号前最后一个词只要命中这些后缀，就当 credits。用「结尾」而不是「包含」判断，
// 是为了不误伤「制作一个梦：…」「人声鼎沸：…」这类正文歌词。
const CN_SUFFIX_PATTERN = uniqueLongestFirst(CN_SUFFIXES);
const EN_SUFFIX_PATTERN = uniqueLongestFirst(EN_SUFFIXES);
const CREDIT_SUFFIX_RE = new RegExp(`(?:${CN_SUFFIX_PATTERN}|${EN_SUFFIX_PATTERN})$`, 'i');

// 中文标签可以用 / 、 & , ， + 及 与 和 等串起来：「作词/作曲：」「词/曲：」「制作人，监制：」
const CN_ONE_LABEL_RE = new RegExp(`^(?:${CN_PATTERN})`, 'i');

// 单个英文制作标签前缀（按最长优先，配合确定性逐段推进，避免嵌套量词回溯导致的 ReDoS）
const EN_ONE_LABEL_RE = new RegExp(
  `^(?:${EN_PATTERN})(?:\\(s\\))?(?=$|[\\s,:/&+：\\-–—|｜=（）()【】\\[\\]])`,
  'i'
);
const EN_SEP_RE = /^(?:\s*(?:[,/&+]|\band\b)\s*|\s+)/i;
const CHAIN_SEP_RE = /^(?:\s*(?:[/／、&＆,，+＋]|及|与|與|\band\b)\s*|\s+和\s+|\s+)/i;
const BARE_WS_RE = /^\s+$/;
const LABEL_PAREN_RE =
  /^\s*(?:[（(][^（）()\r\n]{1,40}[）)]|\[[^\[\]\r\n]{1,40}\]|【[^【】\r\n]{1,40}】)/;
const EN_LABEL_END_RE = /^\s*(?:[:：]|[-–—])/;
const EN_BY_END_RE = /^\s+by\b/i;
const EN_AT_END_RE = /^(?:recorded|mixed|mastered|produced|arranged|engineered|conducted)\s+at\b/i;

// 人声/说唱分段提示在冒号后没有署名时（如「合唱：」「rap：」），属于歌词分段 cue，不当成 credits；
// 只有冒号后确实带了名字（如「Rap：梦然」「合唱：某某合唱团」）才剔除。
const EMPTY_COLON_CUE_EXCLUDED = new Set([
  '合唱',
  '和声',
  '和聲',
  '合声',
  '合聲',
  '伴唱',
  '童声',
  '童聲',
  '旁白',
  '念白',
  '对唱',
  '對唱',
  '独唱',
  '獨唱',
  '男声',
  '男聲',
  '女声',
  '女聲',
  '领唱',
  '領唱',
  '重唱',
  '主唱',
  'rap',
  '说唱',
  '說唱',
]);

// 简写复合标签（如「词/曲/编：张三」「词/曲/编/混：张三」「录/混：李四」），避免单字「编」「混」误伤歌词
const CN_SHORT_COMPOUND_RE =
  /^(?:词|詞|曲|编|編|录|錄)(?:\s*[/／、&＆+＋]\s*(?:词|詞|曲|编|編|录|錄|混|唱|制|製|和|伴|修|配))+\s*(?:[:：]|[-–—｜|=]\s*\S)/;

// 单个词使用非冒号分隔符（- / — / ｜ / =）时可能与歌词冲突的词
const CN_ALT_DELIM_EXCLUDED = new Set([
  '词',
  '詞',
  '曲',
  '鼓',
  '人声',
  '人聲',
  '歌词',
  '歌詞',
  '合唱',
  '和声',
  '和聲',
  '合声',
  '合聲',
  '童声',
  '童聲',
  '旁白',
  '念白',
  '对唱',
  '對唱',
  '设计',
  '設計',
  '音乐',
  '制作',
  '製作',
  '发行',
  '發行',
  '出品',
  '出版',
  '演唱',
  '演奏',
  '翻译',
  '翻譯',
  '宣传',
  '宣傳',
  '推广',
  '推廣',
  '策划',
  '策劃',
  '统筹',
  '統籌',
  '导演',
  '導演',
  '后期',
  '後期',
  '摄影',
  '攝影',
  '配器',
  'lrc',
]);
const EN_PIPE_EQ_EXCLUDED = new Set([
  'music',
  'words',
  'lyrics',
  'lyric',
  'song',
  'title',
  'album',
  'thanks',
  'credit',
  'credits',
  'guitar',
  'piano',
  'drums',
  'drum',
  'bass',
  'strings',
  'chorus',
  'choir',
  'design',
  'art',
  'business',
]);

function matchEnLabelChain(candidate, tailRe) {
  const first = candidate.match(EN_ONE_LABEL_RE);
  if (!first) return false;
  let rest = candidate.slice(first[0].length);

  while (rest.length > 0) {
    if (tailRe.test(rest)) return true;
    const sep = rest.match(EN_SEP_RE);
    if (!sep) return false;
    const afterSep = rest.slice(sep[0].length);
    const next = afterSep.match(EN_ONE_LABEL_RE);
    if (!next) return false;
    rest = afterSep.slice(next[0].length);
  }
  return false;
}

// 统一确定性扫描中文/混合制作标签链：「作词/作曲：」「制作人-张三」「Publisher / 发行商：XXX」「制作人（Music Producer）：张三」
function matchLabelChain(candidate) {
  let rest = candidate;
  let tokenCount = 0;
  let hasCn = false;
  let hasEn = false;
  let lastTokenLower = '';
  let lastKind = '';
  let usedBareWs = false;
  let hasTrailingParen = false;

  while (rest.length > 0) {
    let tok = null;
    let kind = '';

    // 含英文时优先试英文整词匹配，再试中文前缀匹配；纯字符前缀不歧义
    const cnMatch = rest.match(CN_ONE_LABEL_RE);
    const enMatch = rest.match(EN_ONE_LABEL_RE);
    if (cnMatch && (!enMatch || cnMatch[0].length >= enMatch[0].length)) {
      tok = cnMatch[0];
      kind = 'cn';
      hasCn = true;
    } else if (enMatch) {
      tok = enMatch[0];
      kind = 'en';
      hasEn = true;
    } else {
      return false;
    }

    tokenCount++;
    lastTokenLower = tok.toLowerCase();
    lastKind = kind;
    rest = rest.slice(tok.length);

    // 跳过标签后附带的简短括号说明，如「制作人（Music Producer）：」「制作人(中国)：」
    hasTrailingParen = false;
    const paren = rest.match(LABEL_PAREN_RE);
    if (paren) {
      hasTrailingParen = true;
      rest = rest.slice(paren[0].length);
    }

    // 1. 行尾：只对纯中文无括号、无裸空格串接的标签（如单独一行「作词」「作词/作曲」）生效
    if (/^\s*$/.test(rest)) {
      return hasCn && !hasEn && !usedBareWs && !hasTrailingParen;
    }

    // 2. 冒号（: / ：）：人声/合唱/Rap 提示若冒号后为空（如「合唱：」「rap：」），保留给歌词分段提示
    if (/^\s*[:：]/.test(rest)) {
      if (
        tokenCount === 1 &&
        EMPTY_COLON_CUE_EXCLUDED.has(lastTokenLower) &&
        /^\s*[:：]\s*$/.test(rest)
      ) {
        return false;
      }
      return true;
    }

    // 3. 备选分隔符（- / – / — / ＝ / ｜ / |）
    const altMatch = rest.match(/^(\s*)([-–—｜|=])/);
    if (altMatch) {
      const leadWs = altMatch[1];
      const sym = altMatch[2];
      const afterSym = rest.slice(altMatch[0].length);
      const hasValue = /\S/.test(afterSym);

      if (hasValue) {
        // 纯英文的 -/–/— 已由 isEnLabelLine 处理；这里保留并防止把「Music | 音乐」等 ` | ` 双语行当 credits
        if (sym === '|' && leadWs.length > 0 && /^\s/.test(afterSym)) {
          if (hasCn && !hasEn && tokenCount === 1 && !CN_ALT_DELIM_EXCLUDED.has(lastTokenLower)) {
            return true;
          }
          // 若多词或非中英文混合，不把 ` | ` 当作分隔符（交给双语拆分处理）
        } else if (sym === '=' || sym === '｜' || sym === '|') {
          const singleCnExcluded =
            tokenCount === 1 && lastKind === 'cn' && CN_ALT_DELIM_EXCLUDED.has(lastTokenLower);
          const singleEnExcluded =
            tokenCount === 1 && lastKind === 'en' && EN_PIPE_EQ_EXCLUDED.has(lastTokenLower);
          if (!singleCnExcluded && !singleEnExcluded) return true;
        } else {
          // - / – / —
          if (hasEn && !hasCn) return true;
          if (!(
            tokenCount === 1 &&
            lastKind === 'cn' &&
            CN_ALT_DELIM_EXCLUDED.has(lastTokenLower)
          )) {
            return true;
          }
        }
      }
    }

    // 4. 尝试继续匹配下一个串联标签
    const sep = rest.match(CHAIN_SEP_RE);
    if (!sep) return false;
    if (BARE_WS_RE.test(sep[0])) usedBareWs = true;
    rest = rest.slice(sep[0].length);
  }

  return false;
}

// 「Lyrics by…」「Mixed & Mastered by…」「Produced, Arranged and Mixed by…」
function isEnLabelLine(candidate) {
  return matchEnLabelChain(candidate, EN_LABEL_END_RE);
}

function isEnByLine(candidate) {
  return matchEnLabelChain(candidate, EN_BY_END_RE);
}

// 「Recorded at…」「Vocals Recorded at…」「Strings Arranged at…」这类没有 by 的信息行。
// 可选前缀只允许制作标签（及 & / and 等连接符）；不收 "… in"：Written in the stars / Mixed in the crowd 都是正常歌词。
function isEnAtLine(candidate) {
  let rest = candidate;
  while (rest.length > 0) {
    if (EN_AT_END_RE.test(rest)) return true;
    const tok = rest.match(EN_ONE_LABEL_RE);
    if (!tok) return false;
    const afterTok = rest.slice(tok[0].length);
    const sep = afterTok.match(EN_SEP_RE);
    if (!sep) return false;
    rest = afterTok.slice(sep[0].length);
  }
  return false;
}

// 「Guitar played by…」：只接受「乐器 + played by」，不把光秃秃的 Played by 当 credit
const EN_PLAYED_RE = new RegExp(
  '^(?:guitar|bass|drums?|keyboards?|piano|strings?|vocals?|percussion|violin|viola|cello|flute|saxophone|trumpet|trombone|harmonica|harp|organ|programming|synthesizer)\\s+played\\s+by\\b',
  'i'
);

// 没写冒号的「编曲 李宗锦」「发行商 华纳唱片」。只对足够明确的标签生效，
// 避免把「制作 一个梦」「演唱 一首歌」「发行 一张车票」这类正文当成 credits。
const CN_SPACE_CREDIT_RE =
  /^(?:作词|作詞|作曲|编曲|編曲|编曲人|編曲人|作词人|作詞人|作曲人|填词|填詞|词曲|詞曲|制作人|製作人|音乐制作人|音樂製作人|总制作人|總製作人|执行制作人|執行製作人|联合制作人|聯合製作人|配唱制作人|配唱製作人|制作公司|製作公司|制作团队|製作團隊|制作方|製作方|制作商|製作商|监制|監製|总监制|總監製|音乐监制|音樂監製|音乐总监|音樂總監|出品人|出品方|出品公司|联合出品|聯合出品|发行商|發行商|发行方|發行方|发行人|發行人|发行公司|發行公司|发行团队|發行團隊|联合发行|聯合發行|版权方|版權方|版权公司|版權公司|版权代理|版權代理|版权提供|版權提供|出版商|出版方|出版社|出版公司|唱片公司|宣发|宣發|录音|錄音|录音师|錄音師|混音|混音师|混音師|母带|母帶|母带师|母帶師|监唱|配唱|主唱|领唱|領唱|伴唱|演奏|弦乐|弦樂|吉他|贝斯|貝斯|鼓|键盘|鍵盤|钢琴|鋼琴|OP|SP)\s+[^\s:：]/;

// 「第一吉他手：…」「首席小提琴：…」「第2鼓手：…」这类乐手 credit。
// 只认可枚举的乐器词，避免把「第一次牵手：…」这类歌词误判。
const CN_ORDINAL_INSTRUMENT_RE =
  /^(?:第[一二三四五六七八九十百零〇0-9]+|首席)\s*(?:吉他|贝斯|貝斯|鼓|键盘|鍵盤|钢琴|鋼琴|小提琴|中提琴|大提琴|低音提琴|萨克斯|薩克斯|小号|小號|长号|長號|长笛|長笛|短笛|双簧管|雙簧管|单簧管|單簧管|大管|巴松|圆号|圓號|大号|大號|手风琴|手風琴|口琴|二胡|琵琶|古筝|古箏|笛子|箫|簫|唢呐|嗩吶|打击乐|打擊樂|和声|和聲|和音|伴唱|演唱|歌手|主唱|领唱|領唱|说唱|說唱)\s*手?\s*[:：]/;

// 音乐平台发布的翻译/歌词版权声明。平台常把歌名和声明塞进同一行
// （如「Salt - Ava Max QQ音乐享有本翻译作品的著作权」），所以这几条不锚定行首。
const PLATFORM_NAMES = [
  'QQ音乐',
  'QQ音樂',
  '网易云音乐',
  '網易雲音樂',
  '酷我音乐',
  '酷我音樂',
  '酷狗音乐',
  '酷狗音樂',
  '咪咕音乐',
  '咪咕音樂',
  '汽水音乐',
  '汽水音樂',
  '千千音乐',
  '千千音樂',
  '虾米音乐',
  '蝦米音樂',
  '腾讯音乐',
  '騰訊音樂',
  'TME',
  // 品牌简称：酷狗国风品牌『国风新语』这类推广行
  'QQ',
  '网易云',
  '網易雲',
  '酷我',
  '酷狗',
  '咪咕',
  '汽水',
  '千千',
  '虾米',
  '蝦米',
  '腾讯',
  '騰訊',
];
const PLATFORM_PATTERN = [...new Set(PLATFORM_NAMES)].map(escapeRegExp).join('|');
const PLATFORM_NOTICE_RE = new RegExp(
  `(?:${PLATFORM_PATTERN})[\\s\\S]{0,160}?(?:享有|提供|翻译|翻譯|著作权|著作權|版权|版權|音乐人|音樂人|计划|計劃|企划|企劃|独家|獨家|品牌)`,
  'i'
);
// 反向语序：「本翻译作品著作权归QQ音乐所有」
const PLATFORM_NOTICE_REVERSE_RE = new RegExp(
  `(?:享有|提供|翻译|翻譯|著作权|著作權|版权|版權)[\\s\\S]{0,160}?(?:${PLATFORM_PATTERN})`,
  'i'
);
// 只有平台名的推广行，如「【QQ音乐】」「『酷狗音乐』」「「腾讯音乐·正音乐」」
const PLATFORM_ONLY_RE = new RegExp(
  `^[\\s『「【\\[]*(?:${PLATFORM_PATTERN})(?:[·・\\-]\\s*[^』」】\\]\\r\\n]{1,16})?[\\s』」】\\]]*$`,
  'i'
);
// 「酷狗音乐人」「QQ音乐人」这类平台创作者计划徽章
const PLATFORM_CREATOR_RE = new RegExp(
  `^[\\s『「【\\[]*(?:${PLATFORM_PATTERN})人[\\s』」】\\]]*$`,
  'i'
);
const LEADING_PLATFORM_TAG_RE = new RegExp(
  `^(?:[『「【〖\\[(（]\\s*(?:${PLATFORM_PATTERN})\\s*[』」】〗\\])）]\\s*(?:[-–—:：|｜]\\s*)?|(?:${PLATFORM_PATTERN})\\s*[-–—:：|｜]\\s*)`,
  'i'
);
const LEADING_BULLET_RE = /^[※★☆•·●○◆◇■□▲△▶►]+\s*/;

const SPECIAL_RES = [
  // ℗ / © / (P) / (C)，覆盖半角/全角括号
  /^(?:℗|©|\(p\)|\(c\)|（p）|（c）)/i,
  /^(?:phonographic\s+)?copyright\b(?=\s*(?:[:：©℗]|\([cCpP]\)|\d))/i,
  /^all rights reserved\s*[.。]?\s*$/i,
  /^all rights reserved\b.{0,120}?(?:unauthorized|未经|未經|copyright)/i,
  /^unauthorized\b/i,
  // 版权声明：必须同时出现「未经…许可/授权/允许」和「不得/禁止/翻唱/请勿…」才判定，
  // 避免把「未经许可的年少」这类正常歌词删掉
  /^(?:未经|未經).{0,80}?(?:许可|許可|授权|授權|允许|允許|同意).{0,120}?(?:不得|禁止|严禁|嚴禁|请勿|請勿|切勿|不可|翻唱|翻錄|翻录|使用|商用|商业|商業|复制|複製|传播|傳播|转载|轉載|搬运|搬運|盗用|盜用|二改)/,
  // 「本歌曲由…赞助」「本歌曲来自〖飓风计划〗」「本作品…」整句
  /^(?:本歌曲|本作品|本节目|本節目|本单曲|本單曲|本专辑|本專輯|本曲).{0,120}?(?:来自|來自|出自|入选|入選|荣获|榮獲|获得|獲得|赞助|贊助|提供|出品|制作|製作|发行|發行|版权|版權|许可|許可|授权|授權|联合|聯合|打造|企划|企劃|推广|推廣|营销|營銷|运营|運營|独家|獨家)/,
  // 平台激励计划 / 奖项 / 授权版本推广语
  /(?:现金激励|現金激勵|流量扶持|版权分成|版權分成|词曲分成|詞曲分成|音乐人扶持|音樂人扶持)/,
  /^(?:扶持|助力|支持)原创(?:好)?音乐$/,
  /^歌曲于.{0,24}?(?:荣获|榮獲|获得|獲得|入选|入選|登榜|上榜)/,
  /^[「『【〖\[]?.{1,24}(?:广电局|廣電局|文旅厅|文旅廳|文化厅|文化廳|宣传部|宣傳部|版权局|版權局|文联|文聯)[」』】〗\]]?$/,
  /^[《「『【〖\[]?(?:优秀网络视听(?:节目|作品)|五个一工程|中国当代歌曲创作精品工程)[》」』】〗\]]?$/,
  /^(?:正式|官方|正版|独家|獨家)(?:授权|授權).{0,20}$/,
  // 鸣谢/赞助整行（即使没有冒号）
  /^(?:特别鸣谢|特別鳴謝|鸣谢|鳴謝|赞助|贊助)/,
  /^(?:版权所有|版權所有|翻版必究|翻錄必究|翻录必究)/,
  /^(?:全面|倾力|傾力|匠心|重磅|诚意|誠意|精心)?打造.{0,80}?(?:国风|國風).{0,80}?(?:作品|音乐|音樂|专辑|專輯|单曲|單曲)/,
  /^[『「【〖\[]?\s*(?:国风新语|國風新語)\s*[』」】〗\]]?$/,
  /^[^：:\r\n]{2,30}(?:工作团队|工作團隊|制作团队|製作團隊|设计团队|設計團隊|宣发团队|宣發團隊)$/,
  /^special\s+thanks\b/i,
  PLATFORM_NOTICE_RE,
  PLATFORM_NOTICE_REVERSE_RE,
  PLATFORM_ONLY_RE,
  PLATFORM_CREATOR_RE,
];

const BRACKET_PAIRS = new Map([
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
  ['〖', '〗'],
  ['[', ']'],
  ['「', '」'],
  ['『', '』'],
]);
const OPEN_BRACKETS = new Set(BRACKET_PAIRS.keys());
const CLOSE_BRACKETS = new Set(BRACKET_PAIRS.values());

// 只去掉包裹整行最外层的成对括号，用来识别「(作词：张三)」「『作词：张三』」这类写法
function unwrapBrackets(text) {
  let cur = text.trim();
  while (cur.length >= 2 && OPEN_BRACKETS.has(cur[0]) && CLOSE_BRACKETS.has(cur[cur.length - 1])) {
    let depth = 0;
    let closesAtEndOnly = true;
    for (let i = 0; i < cur.length; i++) {
      const ch = cur[i];
      if (OPEN_BRACKETS.has(ch)) {
        depth++;
      } else if (CLOSE_BRACKETS.has(ch)) {
        depth--;
        if (depth < 0 || (depth === 0 && i < cur.length - 1)) {
          closesAtEndOnly = false;
          break;
        }
      }
    }
    if (!closesAtEndOnly || depth !== 0) break;
    cur = cur.slice(1, -1).trim();
  }
  return cur;
}

// 识别「【制作人】张三」「「发行商」华纳唱片」「[Producer] John Doe」这类行首括号标签，
// 避开「【合唱】」「（旁白）」「(Guitar)」等常见歌词分段/配器提示。
const LEADING_BRACKET_LABEL_RE =
  /^([（(【\[「『])\s*([^（）()【】\[\]「」『』\r\n]{1,40})\s*([）)】\]」』])\s*(?:[:：\-–—｜|=]\s*)?(\S.*)$/;
const BRACKET_TAG_CUE_EXCLUDED = new Set([
  '合唱',
  '和声',
  '和聲',
  '合声',
  '合聲',
  '伴唱',
  '童声',
  '童聲',
  '旁白',
  '念白',
  '对唱',
  '對唱',
  '男声',
  '男聲',
  '女声',
  '女聲',
  '演唱',
  '人声',
  '人聲',
  '歌词',
  '歌詞',
  '音乐',
  '音樂',
  '设计',
  '設計',
  'chorus',
  'choir',
  'vocals',
  'vocal',
  'lead vocals',
  'backing vocals',
  'background vocals',
  'guitar',
  'piano',
  'drums',
  'drum',
  'bass',
  'strings',
  'violin',
  'cello',
  'music',
  'words',
  'song',
  'title',
  'album',
]);

function matchBracketedLabelLine(candidate) {
  const match = candidate.match(LEADING_BRACKET_LABEL_RE);
  if (!match) return false;
  const tag = match[2].trim();
  if (!tag || BRACKET_TAG_CUE_EXCLUDED.has(tag.toLowerCase())) return false;
  const synthetic = `${tag}: ${match[4]}`;
  return (
    matchLabelChain(synthetic) ||
    CN_SHORT_COMPOUND_RE.test(synthetic) ||
    CN_ORDINAL_INSTRUMENT_RE.test(synthetic)
  );
}

// 「前缀：名单」类型：只看冒号前最后一个词是否命中制作/版权类后缀。
// 兼容「母带后期处理录音室」「人声录音棚A」「制作人（中国）」「制作公司Manufacturing company」这类组合写法。
const COMPANY_OR_TEAM_EMPTY_TAIL_RE =
  /(?:有限公司|有限责任公司|有限責任公司|股份有限公司|股份公司|公司|团队|團隊|单位|單位|工作室|录音室|錄音室|录音棚|錄音棚|机构|機構|中心|部门|部門|组织|組織)$/;

function hasCreditSuffix(candidate) {
  const match = candidate.match(/^([^：:\r\n]{1,80})[：:](?:\s*(\S.*))?$/);
  if (!match) return false;

  const raw = match[1].trim();
  if (!raw) return false;

  if (!match[2]) {
    return COMPANY_OR_TEAM_EMPTY_TAIL_RE.test(raw);
  }

  const variants = new Set([raw]);
  const noParen = raw.replace(/\s*[（(【\[][^（）()【】\[\]\r\n]*[）)】\]]\s*$/, '').trim();
  if (noParen) variants.add(noParen);

  for (const value of [...variants]) {
    const noSlashEn = value
      .replace(/\s*[/／]\s*[A-Za-z0-9][A-Za-z0-9\s/／&\-().]{0,50}$/, '')
      .trim();
    if (noSlashEn) variants.add(noSlashEn);

    const noConcatEn = value
      .replace(/([\p{sc=Han}])([A-Za-z][A-Za-z0-9\s/／&\-().]{1,50})$/u, '$1')
      .trim();
    if (noConcatEn && noConcatEn !== value) variants.add(noConcatEn);

    const noTrailingLatin = value
      .replace(/\s*[/／]?[A-Za-z0-9]+(?:\s*[/／]\s*[A-Za-z0-9]+)*(?:\(s\))?\s*$/, '')
      .trim();
    if (noTrailingLatin) variants.add(noTrailingLatin);

    const noPluralS = value.replace(/\(s\)\s*$/i, '').trim();
    if (noPluralS) variants.add(noPluralS);
  }

  for (const value of variants) {
    if (value && CREDIT_SUFFIX_RE.test(value)) return true;
  }
  return false;
}

/**
 * 判断一行歌词是不是制作信息/版权/赞助等非歌词内容。
 * 只判断整行，不修改行内文本。
 */
const MAX_CREDIT_SCAN_LENGTH = 2000;

export function isCreditLine(text) {
  if (typeof text !== 'string') return false;

  // 行首的 // 是部分歌词文件的分隔符；清掉 BOM/零宽控制符，NBSP 转为空格
  const cleaned = text
    .replace(/[\u00a0\u200b\u200c\u200e\u200f\u2060\ufeff\u00ad]/g, (ch) =>
      ch === '\u00a0' ? ' ' : ''
    )
    .replace(/^\/+\s*/, '')
    .trim();
  if (!cleaned) return false;

  const trimmed =
    cleaned.length > MAX_CREDIT_SCAN_LENGTH ? cleaned.slice(0, MAX_CREDIT_SCAN_LENGTH) : cleaned;

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const v = value.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      candidates.push(v);
    }
  };

  pushCandidate(trimmed);
  const unwrapped = unwrapBrackets(trimmed);
  if (unwrapped !== trimmed) pushCandidate(unwrapped);

  for (const base of [...candidates]) {
    const noBullet = base.replace(LEADING_BULLET_RE, '');
    if (noBullet !== base) pushCandidate(noBullet);
    const noPlatform = noBullet.replace(LEADING_PLATFORM_TAG_RE, '');
    if (noPlatform !== noBullet) pushCandidate(noPlatform);
  }

  for (const candidate of candidates) {
    if (SPECIAL_RES.some((re) => re.test(candidate))) return true;
    if (matchLabelChain(candidate)) return true;
    if (CN_SHORT_COMPOUND_RE.test(candidate)) return true;
    if (isEnLabelLine(candidate)) return true;
    if (isEnByLine(candidate)) return true;
    if (isEnAtLine(candidate)) return true;
    if (EN_PLAYED_RE.test(candidate)) return true;
    if (CN_ORDINAL_INSTRUMENT_RE.test(candidate)) return true;
    if (CN_SPACE_CREDIT_RE.test(candidate)) return true;
    if (matchBracketedLabelLine(candidate)) return true;
    if (hasCreditSuffix(candidate)) return true;
  }

  return false;
}

const HEADER_SCAN_LINES = 5;

// 去掉空格、常见分隔符和标点后再比较，避免「保留 - 郭顶」「郭顶《保留》」这类
// 排版差异导致漏判。只用于头部比对，不用于展示。
function compactInfo(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(/[\s\-–—/|·:：,，.。!！?？'‘’"“”()（）《》【】\[\]&+、]/g, '');
}

// 去掉所有成对括号里的内容（支持嵌套），用来处理带英文名/专辑宣传语的头部：
// 「破茧 - 张韶涵 (Angela Zhang)」「命运火焰 (《永劫无间》推广曲) - 詹雯婷」
function removeBracketedInfo(text) {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if ('（(【〖[《「『'.includes(ch)) {
      depth++;
      continue;
    }
    if ('）)】〗]》」』'.includes(ch)) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function splitArtistList(raw, splitDash = false) {
  if (typeof raw !== 'string') return [];
  const cleaned = removeBracketedInfo(raw);
  const sep = splitDash ? /[/／、,，&＆+\-–—]+/ : /[/／、,，&＆+]+|\s+[-–—]\s+/;
  return cleaned.split(sep).map(compactInfo).filter(Boolean);
}

function splitArtistSignature(raw) {
  const parts = splitArtistList(raw).sort();
  return parts.join('\u0000');
}

function matchesArtistAndTitle(rawText, title, rawArtist, artist, artistSignature, index) {
  if (!title || !artist) return false;
  const headerRaw = removeBracketedInfo(rawText);
  const headerCompact = compactInfo(headerRaw);
  if (!headerCompact) return false;

  if (headerCompact === title + artist || headerCompact === artist + title) {
    return true;
  }

  // 支持多位歌手顺序/署名差异，如：
  // - 音频「镜予歌/陈亦洺/尚辰」 vs LRC「陈亦洺、尚辰、镜予歌 - 千秋迭梦」
  // - 音频「Alan Walker/Iselin Solheim」 vs LRC「Alan Walker - Faded」
  // - 音频「3LAU/Carly Paige」 vs LRC「3LAU、Carly Paige、Marc... - Touch」
  // - 音频「不才、三体宇宙」 vs LRC「夜航星 (Night Voyager) - 蔡明希-不才/三体宇宙」
  // - 音频「伶」 vs LRC「散る散る満ちる (散落飘零) - 鹫尾伶菜」（前两行精确歌名 + 空格短横线）
  const songArtists = splitArtistList(rawArtist);
  const segments = headerRaw
    .split(/\s*[-–—|/／]+\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = 0; i < segments.length; i++) {
    if (compactInfo(segments[i]) !== title) continue;
    const otherRaw = [...segments.slice(0, i), ...segments.slice(i + 1)].join(' / ');
    if (!otherRaw) continue;

    if (artistSignature && splitArtistSignature(otherRaw) === artistSignature) {
      return true;
    }

    const otherTokens = new Set(splitArtistList(otherRaw, true));
    if (songArtists.length > 0 && songArtists.every((a) => otherTokens.has(a))) {
      return true;
    }
    if (songArtists.length > 1 && songArtists[0].length >= 2 && otherTokens.has(songArtists[0])) {
      return true;
    }

    if (
      index < 2 &&
      title.length >= 3 &&
      /\s+[-–—]\s+/.test(headerRaw) &&
      otherRaw.length <= 40 &&
      !/[，。！？,.!?]/.test(otherRaw) &&
      songArtists[0] &&
      compactInfo(otherRaw).includes(songArtists[0])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 去掉内嵌歌词常见的「歌名 - 歌手」头部。
 *
 * 只扫描开头几行，并且要求整行基本只由歌名/歌手/专辑组成（或单独成行），
 * 避免把正文里恰好出现歌名或歌手名的歌词删掉。
 * @param {Array<{text: string, translation?: string}>} lines
 * @param {{title?: string, artist?: string, album?: string}} song
 * @param {{title?: string, artist?: string, album?: string}|null} [lrcMetadata]
 */
export function stripSongHeader(lines, song, lrcMetadata = null) {
  if (!Array.isArray(lines) || lines.length === 0 || (!song && !lrcMetadata)) return lines;

  const sources = [];
  const metaList = [song, lrcMetadata].filter(Boolean);
  for (const primary of metaList) {
    const rawTitle = primary.title || lrcMetadata?.title || song?.title || '';
    const rawArtist = primary.artist || lrcMetadata?.artist || song?.artist || '';
    const rawAlbum = primary.album || lrcMetadata?.album || song?.album || '';
    const title = compactInfo(rawTitle);
    const titleNoBracket = compactInfo(removeBracketedInfo(rawTitle));
    const artist = compactInfo(rawArtist);
    const artistNoBracket = compactInfo(removeBracketedInfo(rawArtist));
    const album = compactInfo(rawAlbum);
    if (title || artist) {
      sources.push({
        rawTitle,
        rawArtist,
        title,
        titleVariants: [...new Set([title, titleNoBracket].filter(Boolean))],
        artist,
        artistVariants: [...new Set([artist, artistNoBracket].filter(Boolean))],
        artistSignature: splitArtistSignature(rawArtist),
        album,
      });
    }
  }
  if (sources.length === 0) return lines;

  const limit = Math.min(lines.length, HEADER_SCAN_LINES);
  const head = lines.slice(0, limit);

  // 「歌名 + 歌手」「歌手 + 歌名」；有专辑时再允许三者按任意顺序拼接
  const combined = new Set();
  const titleSet = new Set();
  const artistSet = new Set();

  for (const src of sources) {
    for (const t of src.titleVariants) titleSet.add(t);
    for (const a of src.artistVariants) artistSet.add(a);

    if (src.titleVariants.length > 0 && src.artistVariants.length > 0) {
      for (const t of src.titleVariants) {
        for (const a of src.artistVariants) {
          combined.add(t + a);
          combined.add(a + t);
          if (src.album) {
            const permute = (items) =>
              items.length <= 1
                ? [items]
                : items.flatMap((item, i) =>
                    permute([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
                      item,
                      ...rest,
                    ])
                  );
            for (const permutation of permute([t, a, src.album])) {
              combined.add(permutation.join(''));
            }
          }
        }
      }
    } else if (src.titleVariants.length > 0 && src.album) {
      for (const t of src.titleVariants) {
        combined.add(t + src.album);
        combined.add(src.album + t);
      }
    }
  }

  const headerTextOf = (line) =>
    compactInfo(removeBracketedInfo(line.text || line.translation || ''));
  const hasArtistLine =
    artistSet.size > 0 &&
    head.some((line) => {
      const h = headerTextOf(line);
      const raw = line.text || line.translation || '';
      return (
        artistSet.has(h) ||
        sources.some((s) => s.artistSignature && splitArtistSignature(raw) === s.artistSignature)
      );
    });

  return lines.filter((line, index) => {
    if (index >= limit) return true;

    const rawText = line.text || line.translation || '';
    if (!rawText) return true;
    const headerText = headerTextOf(line);
    if (!headerText) return true;

    // 单独成行的歌手名；或紧挨着歌手行的歌名行（常见内嵌歌词头两行）
    if (
      artistSet.has(headerText) ||
      sources.some((s) => s.artistSignature && splitArtistSignature(rawText) === s.artistSignature)
    ) {
      return false;
    }
    if (titleSet.has(headerText) && (hasArtistLine || /[-–—/|·]\s*$/.test(rawText))) {
      return false;
    }

    // 「歌名 - 歌手」「歌手 / 歌名」「歌名 - 歌手 - 专辑」等组合行；
    // 括号里的英文名/专辑宣传语已在 headerTextOf 里去掉
    if (combined.has(headerText)) return false;

    for (const src of sources) {
      for (const t of src.titleVariants) {
        for (const a of src.artistVariants) {
          if (matchesArtistAndTitle(rawText, t, src.rawArtist, a, src.artistSignature, index)) {
            return false;
          }
        }
      }
    }

    return true;
  });
}
