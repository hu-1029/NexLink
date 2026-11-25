import React, { useId } from 'react';

interface SparklineChartProps {
  data: number[];
  color?: string;
  height?: number;
  className?: string;
}

/**
 * 现代轻量级 SVG 平滑波浪走势图 (Bézier Smooth Sparkline)
 * 无外部重型图表库依赖，零开销，平滑渲染网速波浪曲线
 */
export const SparklineChart: React.FC<SparklineChartProps> = ({
  data,
  color = '#3b82f6',
  height = 42,
  className = '',
}) => {
  const gradientId = useId();

  // 保证至少有 2 个点以绘制线条
  const points = data.length >= 2 ? data : [0, ...data, 0];
  const maxVal = Math.max(...points, 10);
  const minVal = 0;
  const range = maxVal - minVal || 1;

  const width = 240;
  const h = height;
  const paddingY = 4;
  const effectiveHeight = h - paddingY * 2;

  // 将数据归一化为坐标点
  const coords: Array<[number, number]> = points.map((val, idx) => {
    const x = (idx / (points.length - 1)) * width;
    const y = h - paddingY - ((val - minVal) / range) * effectiveHeight;
    return [x, y];
  });

  // 使用三次贝塞尔曲线生成平滑路径
  let pathD = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = coords[i];
    const [x1, y1] = coords[i + 1];
    const cpx1 = x0 + (x1 - x0) / 2;
    const cpy1 = y0;
    const cpx2 = x0 + (x1 - x0) / 2;
    const cpy2 = y1;
    pathD += ` C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${x1} ${y1}`;
  }

  // 闭合底部区域路径用于渐变填充
  const areaD = `${pathD} L ${width} ${h} L 0 ${h} Z`;

  return (
    <div className={`w-full overflow-hidden pointer-events-none select-none ${className}`}>
      <svg
        viewBox={`0 0 ${width} ${h}`}
        className="w-full h-full overflow-visible"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="70%" stopColor={color} stopOpacity="0.08" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* 波浪半透明渐变区域 */}
        <path d={areaD} fill={`url(#${gradientId})`} />
        {/* 顶部主波浪线条 */}
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
