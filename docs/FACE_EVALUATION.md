# 人物聚类评测

为了避免只凭肉眼调整阈值，可以从已经确认的人物中抽取一小批人脸，创建 CSV：

```csv
embedding_path,person_label
00012300.npy,张三
00012801.npy,张三
00022000.npy,李四
```

运行：

```bash
ai_worker/.venv/bin/python scripts/evaluate_face_clustering.py \
  /path/to/photo-library labels.csv --threshold 0.60
```

脚本只读取 `.npy` 特征，不修改照片或 `.pf` 数据库。重点关注：

- `pair_precision`：自动合并的安全性，应该优先保持较高；
- `pair_recall`：同一个人被找回的程度；
- `people_split_into_multiple_groups`：仍被拆分的人数；
- `false_merge_pairs`：不同人物被误合的数量。

建议评测集包含正脸、侧脸、低光、眼镜、口罩和跨年龄照片，并在每次更换模型或聚类规则后重复运行。
