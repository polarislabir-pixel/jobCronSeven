"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  Loader2,
  Briefcase,
  Building2,
  MapPin,
  Calendar,
  ExternalLink,
  Clock,
  TrendingUp,
  Filter,
  BarChart3,
  Target,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  Area,
} from "recharts";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./applied.css";

interface AppliedJob {
  id: string;
  jobId: string;
  appliedAt: string;
  jobTitle: string;
  company: string;
  location: string;
  originalUrl: string;
  postedDate: string;
  roleType?: string;
  industry?: string;
}

interface Stats {
  totalApplications: number;
  applicationsByMonth: Record<string, number>;
  lastUpdated: string;
}

const CHART_COLORS = ["#00d4ff", "#00ff88", "#ffcc00", "#ff6b6b", "#9d4edd", "#4cc9f0", "#06ffa5", "#ff006e"];

// Calculate delay in minutes between posted and applied
const calculateDelayMinutes = (postedDate: string, appliedAt: string): number | null => {
  if (!postedDate || !appliedAt) return null;
  const posted = new Date(postedDate).getTime();
  const applied = new Date(appliedAt).getTime();
  if (isNaN(posted) || isNaN(applied)) return null;
  const diffMs = applied - posted;
  if (diffMs < 0) return null; // Applied before posted (data issue)
  return Math.floor(diffMs / 60000); // Convert to minutes
};

// Format delay in a human-readable way with minute accuracy
const formatDelay = (minutes: number | null): string => {
  if (minutes === null) return "N/A";
  if (minutes < 0) return "N/A";

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  } else if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else {
    return `${mins}m`;
  }
};

// Format delay for compact display
const formatDelayCompact = (minutes: number | null): string => {
  if (minutes === null) return "N/A";
  if (minutes < 0) return "N/A";

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else {
    return `${mins}m`;
  }
};

type AppliedNamespace = "default" | "aryan";

export default function AppliedJobsPage() {
  const [applications, setApplications] = useState<AppliedJob[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [namespace, setNamespace] = useState<AppliedNamespace>("default");

  const fetchApplications = async (month?: string, ns: AppliedNamespace = namespace) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (month) params.set("month", month);
      params.set("namespace", ns);
      const url = `/api/applied?${params.toString()}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.success) {
        setApplications(data.data);
        setStats(data.stats);
      } else {
        setError(data.error || "Failed to fetch applications");
      }
    } catch (err) {
      setError("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApplications(undefined, "default");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMonthChange = (month: string) => {
    setSelectedMonth(month);
    fetchApplications(month || undefined, namespace);
  };

  const handleNamespaceChange = (ns: AppliedNamespace) => {
    if (ns === namespace) return;
    setNamespace(ns);
    setSelectedMonth("");
    fetchApplications(undefined, ns);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatShortDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
    });
  };

  const getTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateString);
  };

  const availableMonths = stats
    ? Object.keys(stats.applicationsByMonth).sort().reverse()
    : [];

  // Analytics data calculations
  const analyticsData = useMemo(() => {
    if (!applications.length) return null;

    // Applications by date (last 14 days)
    const byDate: Record<string, number> = {};
    applications.forEach((app) => {
      const date = app.appliedAt.split("T")[0];
      byDate[date] = (byDate[date] || 0) + 1;
    });
    const dateData = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([date, count]) => ({
        date: new Date(date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        applications: count,
      }));

    // Applications by company
    const byCompany: Record<string, number> = {};
    applications.forEach((app) => {
      byCompany[app.company] = (byCompany[app.company] || 0) + 1;
    });
    const companyData = Object.entries(byCompany)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([name, value]) => ({ name, value }));

    // Applications by location
    const byLocation: Record<string, number> = {};
    applications.forEach((app) => {
      if (app.location) {
        // Extract city/country from location
        const loc = app.location.split(",")[0].trim();
        byLocation[loc] = (byLocation[loc] || 0) + 1;
      }
    });
    const locationData = Object.entries(byLocation)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([name, value]) => ({ name, value }));

    // Applications by industry (if available)
    const byIndustry: Record<string, number> = {};
    applications.forEach((app) => {
      if (app.industry) {
        byIndustry[app.industry] = (byIndustry[app.industry] || 0) + 1;
      }
    });
    const industryData = Object.entries(byIndustry)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([name, value]) => ({ name, value }));

    // Applications by role type (if available)
    const byRoleType: Record<string, number> = {};
    applications.forEach((app) => {
      if (app.roleType) {
        byRoleType[app.roleType] = (byRoleType[app.roleType] || 0) + 1;
      }
    });
    const roleTypeData = Object.entries(byRoleType)
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name, value }));

    // Average applications per day
    const uniqueDays = Object.keys(byDate).length;
    const avgPerDay = uniqueDays > 0 ? (applications.length / uniqueDays).toFixed(1) : "0";

    // Most active day
    const mostActiveDay = Object.entries(byDate).sort(([, a], [, b]) => b - a)[0];

    // Calculate delay statistics
    const delays: number[] = [];
    applications.forEach((app) => {
      const delay = calculateDelayMinutes(app.postedDate, app.appliedAt);
      if (delay !== null && delay >= 0) {
        delays.push(delay);
      }
    });

    // Average delay in minutes
    const avgDelayMinutes = delays.length > 0
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : null;

    // Median delay
    const sortedDelays = [...delays].sort((a, b) => a - b);
    const medianDelayMinutes = sortedDelays.length > 0
      ? sortedDelays[Math.floor(sortedDelays.length / 2)]
      : null;

    // Min and max delay
    const minDelayMinutes = delays.length > 0 ? Math.min(...delays) : null;
    const maxDelayMinutes = delays.length > 0 ? Math.max(...delays) : null;

    // Delay distribution buckets (in hours for visualization)
    const delayBuckets: Record<string, number> = {
      "< 1h": 0,
      "1-6h": 0,
      "6-12h": 0,
      "12-24h": 0,
      "1-2d": 0,
      "2-7d": 0,
      "> 7d": 0,
    };

    delays.forEach((mins) => {
      if (mins < 60) delayBuckets["< 1h"]++;
      else if (mins < 360) delayBuckets["1-6h"]++;
      else if (mins < 720) delayBuckets["6-12h"]++;
      else if (mins < 1440) delayBuckets["12-24h"]++;
      else if (mins < 2880) delayBuckets["1-2d"]++;
      else if (mins < 10080) delayBuckets["2-7d"]++;
      else delayBuckets["> 7d"]++;
    });

    const delayDistributionData = Object.entries(delayBuckets)
      .filter(([, count]) => count > 0)
      .map(([range, count]) => ({ range, count }));

    // Average delay per day (for trend visualization)
    const delaysByDate: Record<string, number[]> = {};
    applications.forEach((app) => {
      const delay = calculateDelayMinutes(app.postedDate, app.appliedAt);
      if (delay !== null && delay >= 0) {
        const date = app.appliedAt.split("T")[0];
        if (!delaysByDate[date]) delaysByDate[date] = [];
        delaysByDate[date].push(delay);
      }
    });

    const dailyDelayData = Object.entries(delaysByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14) // Last 14 days
      .map(([date, delays]) => {
        const avgDelay = Math.round(delays.reduce((a, b) => a + b, 0) / delays.length);
        const minDelay = Math.min(...delays);
        const maxDelay = Math.max(...delays);
        return {
          date: new Date(date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          avgDelayHours: Number((avgDelay / 60).toFixed(1)), // Convert to hours for better visualization
          avgDelayMinutes: avgDelay,
          minDelayHours: Number((minDelay / 60).toFixed(1)),
          maxDelayHours: Number((maxDelay / 60).toFixed(1)),
          count: delays.length,
        };
      });

    return {
      dateData,
      companyData,
      locationData,
      industryData,
      roleTypeData,
      avgPerDay,
      mostActiveDay,
      totalCompanies: Object.keys(byCompany).length,
      totalLocations: Object.keys(byLocation).length,
      // Delay statistics
      avgDelayMinutes,
      medianDelayMinutes,
      minDelayMinutes,
      maxDelayMinutes,
      delayDistributionData,
      dailyDelayData,
      totalWithDelay: delays.length,
    };
  }, [applications]);

  return (
    <div className="terminal-page">
      {/* Top Bar */}
      <div className="terminal-topbar">
        <div className="terminal-topbar-left">
          <Briefcase size={20} />
          <span className="terminal-title">APPLICATION TRACKER</span>
          <span className="terminal-separator">|</span>
          <span className="terminal-subtitle">JOB APPLICATION ANALYTICS</span>
        </div>
        <div className="terminal-topbar-right">
          <div className="terminal-btn-group" style={{ display: "inline-flex", gap: 0, marginRight: 8 }}>
            <button
              onClick={() => handleNamespaceChange("default")}
              disabled={loading}
              className={`terminal-btn ${namespace === "default" ? "active" : ""}`}
              title="Main pipeline applications"
            >
              <span>NORMAL</span>
            </button>
            <button
              onClick={() => handleNamespaceChange("aryan")}
              disabled={loading}
              className={`terminal-btn ${namespace === "aryan" ? "active" : ""}`}
              title="Aryan pipeline applications"
            >
              <span>ARYAN</span>
            </button>
          </div>
          <button
            onClick={() => fetchApplications(selectedMonth || undefined, namespace)}
            disabled={loading}
            className={`terminal-btn ${loading ? "loading" : ""}`}
          >
            {loading ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            <span>REFRESH</span>
          </button>
          <Link href="/stats" className="terminal-btn">
            <BarChart3 size={14} />
            <span>STATS</span>
          </Link>
          <Link href="/" className="terminal-btn">
            <ArrowLeft size={14} />
            <span>HOME</span>
          </Link>
          <ThemeToggle />
        </div>
      </div>

      {/* Status Bar */}
      {stats && (
        <div className="terminal-statusbar">
          <div className="status-item highlight">
            <Briefcase size={12} />
            <span>DATASET: {namespace === "aryan" ? "ARYAN" : "NORMAL"}</span>
          </div>
          <div className="status-item">
            <Target size={12} />
            <span>TOTAL: {stats.totalApplications}</span>
          </div>
          <div className="status-item">
            <Calendar size={12} />
            <span>MONTHS: {availableMonths.length}</span>
          </div>
          <div className="status-item">
            <Clock size={12} />
            <span>
              UPDATED:{" "}
              {stats.lastUpdated ? getTimeAgo(stats.lastUpdated) : "Never"}
            </span>
          </div>
          {selectedMonth && (
            <div className="status-item highlight">
              <Filter size={12} />
              <span>FILTER: {selectedMonth}</span>
            </div>
          )}
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="terminal-alert error">✗ ERROR: {error}</div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="terminal-loading">
          <Loader2 size={32} className="spin" />
          <p>LOADING APPLICATION DATA...</p>
        </div>
      )}

      {/* Main Content */}
      {!loading && (
        <div className="terminal-grid">
          {/* Key Metrics Panel */}
          <div className="terminal-panel span-full">
            <div className="panel-header">
              <TrendingUp size={14} />
              <span>KEY METRICS</span>
            </div>
            <div className="metrics-compact">
              <div className="metric-compact">
                <div className="metric-compact-label">TOTAL APPLICATIONS</div>
                <div className="metric-compact-value highlight">
                  {stats?.totalApplications || 0}
                </div>
              </div>
              <div className="metric-compact">
                <div className="metric-compact-label">COMPANIES</div>
                <div className="metric-compact-value">
                  {analyticsData?.totalCompanies || 0}
                </div>
              </div>
              <div className="metric-compact">
                <div className="metric-compact-label">LOCATIONS</div>
                <div className="metric-compact-value">
                  {analyticsData?.totalLocations || 0}
                </div>
              </div>
              <div className="metric-compact">
                <div className="metric-compact-label">AVG/DAY</div>
                <div className="metric-compact-value warning">
                  {analyticsData?.avgPerDay || "0"}
                </div>
              </div>
              <div className="metric-compact">
                <div className="metric-compact-label">MONTHS TRACKED</div>
                <div className="metric-compact-value">
                  {availableMonths.length}
                </div>
              </div>
              <div className="metric-compact">
                <div className="metric-compact-label">AVG DELAY</div>
                <div className="metric-compact-value" style={{ color: "#ff6b6b" }}>
                  {analyticsData && analyticsData.avgDelayMinutes !== null
                    ? formatDelayCompact(analyticsData.avgDelayMinutes)
                    : "N/A"}
                </div>
              </div>
              <div className="metric-compact">
                <div className="metric-compact-label">FILTER</div>
                <div className="filter-section" style={{ padding: 0 }}>
                  <select
                    value={selectedMonth}
                    onChange={(e) => handleMonthChange(e.target.value)}
                    className="month-select"
                  >
                    <option value="">All Months</option>
                    {availableMonths.map((month) => (
                      <option key={month} value={month}>
                        {month} ({stats?.applicationsByMonth[month] || 0})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Application Timeline */}
          {analyticsData && analyticsData.dateData.length > 0 && (
            <div className="terminal-panel span-2">
              <div className="panel-header">
                <TrendingUp size={14} />
                <span>APPLICATION VELOCITY</span>
              </div>
              <div className="chart-container compact" style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={analyticsData.dateData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a2332" />
                    <XAxis
                      dataKey="date"
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0e1a",
                        border: "1px solid #00d4ff",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#00d4ff" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="applications"
                      stroke="#00d4ff"
                      strokeWidth={2}
                      dot={{ fill: "#00d4ff", r: 4 }}
                      activeDot={{ r: 6, fill: "#00ff88" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Monthly Breakdown */}
          {stats && Object.keys(stats.applicationsByMonth).length > 0 && (
            <div className="terminal-panel">
              <div className="panel-header">
                <Calendar size={14} />
                <span>MONTHLY BREAKDOWN</span>
              </div>
              <div style={{ padding: "0.75rem", maxHeight: 200, overflowY: "auto" }}>
                {Object.entries(stats.applicationsByMonth)
                  .sort(([a], [b]) => b.localeCompare(a))
                  .map(([month, count]) => (
                    <div key={month} className="month-item">
                      <span className="month-name">{month}</span>
                      <span className="month-count">{count}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Top Companies */}
          {analyticsData && analyticsData.companyData.length > 0 && (
            <div className="terminal-panel">
              <div className="panel-header">
                <Building2 size={14} />
                <span>TOP COMPANIES</span>
              </div>
              <div className="chart-container compact" style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={analyticsData.companyData}
                    layout="vertical"
                    margin={{ top: 5, right: 20, left: 5, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a2332" />
                    <XAxis
                      type="number"
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                      allowDecimals={false}
                    />
                    <YAxis
                      dataKey="name"
                      type="category"
                      stroke="#4a5568"
                      width={80}
                      tick={{ fontSize: 8 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0e1a",
                        border: "1px solid #9d4edd",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#9d4edd" }}
                    />
                    <Bar
                      dataKey="value"
                      fill="#9d4edd"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Locations */}
          {analyticsData && analyticsData.locationData.length > 0 && (
            <div className="terminal-panel">
              <div className="panel-header">
                <MapPin size={14} />
                <span>TOP LOCATIONS</span>
              </div>
              <div className="chart-container compact" style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={analyticsData.locationData}
                    layout="vertical"
                    margin={{ top: 5, right: 20, left: 5, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a2332" />
                    <XAxis
                      type="number"
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                      allowDecimals={false}
                    />
                    <YAxis
                      dataKey="name"
                      type="category"
                      stroke="#4a5568"
                      width={80}
                      tick={{ fontSize: 8 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0e1a",
                        border: "1px solid #4cc9f0",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#4cc9f0" }}
                    />
                    <Bar
                      dataKey="value"
                      fill="#4cc9f0"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Industry Distribution (if data available) */}
          {analyticsData && analyticsData.industryData.length > 0 && (
            <div className="terminal-panel">
              <div className="panel-header">
                <Briefcase size={14} />
                <span>INDUSTRY DISTRIBUTION</span>
              </div>
              <div
                className="chart-container compact"
                style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={analyticsData.industryData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) =>
                        `${name} ${((percent || 0) * 100).toFixed(0)}%`
                      }
                      outerRadius={70}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {analyticsData.industryData.map((_, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={CHART_COLORS[index % CHART_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0e1a",
                        border: "1px solid #ffcc00",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#ffcc00" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Application Response Time Analysis */}
          {analyticsData && analyticsData.delayDistributionData.length > 0 && (
            <div className="terminal-panel span-2">
              <div className="panel-header">
                <Clock size={14} />
                <span>APPLICATION RESPONSE TIME</span>
                <span style={{ marginLeft: "auto", fontSize: "0.65rem", color: "#6b7280" }}>
                  Time between job posting and your application
                </span>
              </div>
              <div className="chart-container compact" style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={analyticsData.delayDistributionData}
                    margin={{ top: 10, right: 20, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a2332" />
                    <XAxis
                      dataKey="range"
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0e1a",
                        border: "1px solid #ff6b6b",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#ff6b6b" }}
                      formatter={(value) => [`${value ?? 0} applications`, "Count"]}
                    />
                    <Bar
                      dataKey="count"
                      fill="#ff6b6b"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                padding: "0.5rem 0.75rem",
                borderTop: "1px solid #1a2332",
                fontSize: "0.7rem"
              }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#6b7280" }}>AVERAGE</div>
                  <div style={{ color: "#ff6b6b", fontWeight: "bold" }}>
                    {formatDelay(analyticsData.avgDelayMinutes)}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#6b7280" }}>MEDIAN</div>
                  <div style={{ color: "#ffcc00", fontWeight: "bold" }}>
                    {formatDelay(analyticsData.medianDelayMinutes)}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#6b7280" }}>FASTEST</div>
                  <div style={{ color: "#00ff88", fontWeight: "bold" }}>
                    {formatDelay(analyticsData.minDelayMinutes)}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#6b7280" }}>SLOWEST</div>
                  <div style={{ color: "#9d4edd", fontWeight: "bold" }}>
                    {formatDelay(analyticsData.maxDelayMinutes)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Daily Average Delay Trend */}
          {analyticsData && analyticsData.dailyDelayData.length >= 1 && (
            <div className="terminal-panel span-full">
              <div className="panel-header">
                <TrendingUp size={14} />
                <span>DAILY RESPONSE TIME TREND</span>
                <span style={{ marginLeft: "auto", fontSize: "0.65rem", color: "#6b7280" }}>
                  Average delay per day (in hours) with min/max range
                </span>
              </div>
              <div className="chart-container compact" style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart
                    data={analyticsData.dailyDelayData}
                    margin={{ top: 10, right: 30, left: 10, bottom: 5 }}
                  >
                    <defs>
                      <linearGradient id="delayGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ff6b6b" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#ff6b6b" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a2332" />
                    <XAxis
                      dataKey="date"
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      stroke="#4a5568"
                      tick={{ fontSize: 10 }}
                      label={{
                        value: "Hours",
                        angle: -90,
                        position: "insideLeft",
                        style: { fill: "#6b7280", fontSize: 10 }
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0e1a",
                        border: "1px solid #ff6b6b",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#ff6b6b" }}
                      formatter={(value, name) => {
                        const v = typeof value === "number" ? value : 0;
                        if (name === "avgDelayHours") {
                          const hours = Math.floor(v);
                          const mins = Math.round((v - hours) * 60);
                          return [`${hours}h ${mins}m`, "Avg Delay"];
                        }
                        if (name === "minDelayHours") {
                          const hours = Math.floor(v);
                          const mins = Math.round((v - hours) * 60);
                          return [`${hours}h ${mins}m`, "Min Delay"];
                        }
                        if (name === "maxDelayHours") {
                          const hours = Math.floor(v);
                          const mins = Math.round((v - hours) * 60);
                          return [`${hours}h ${mins}m`, "Max Delay"];
                        }
                        return [v, name];
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="maxDelayHours"
                      fill="url(#delayGradient)"
                      stroke="none"
                    />
                    <Line
                      type="monotone"
                      dataKey="minDelayHours"
                      stroke="#00ff88"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="maxDelayHours"
                      stroke="#9d4edd"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="avgDelayHours"
                      stroke="#ff6b6b"
                      strokeWidth={2}
                      dot={{ fill: "#ff6b6b", r: 4 }}
                      activeDot={{ r: 6, fill: "#ffcc00" }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div style={{
                display: "flex",
                justifyContent: "center",
                gap: "2rem",
                padding: "0.5rem",
                borderTop: "1px solid #1a2332",
                fontSize: "0.65rem"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <div style={{ width: 12, height: 2, backgroundColor: "#ff6b6b" }} />
                  <span style={{ color: "#6b7280" }}>Average</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <div style={{ width: 12, height: 2, backgroundColor: "#00ff88", borderStyle: "dashed" }} />
                  <span style={{ color: "#6b7280" }}>Fastest</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <div style={{ width: 12, height: 2, backgroundColor: "#9d4edd", borderStyle: "dashed" }} />
                  <span style={{ color: "#6b7280" }}>Slowest</span>
                </div>
              </div>
            </div>
          )}

          {/* Applications Table */}
          <div className="terminal-panel span-full">
            <div className="panel-header">
              <Briefcase size={14} />
              <span>
                APPLICATIONS ({applications.length})
                {selectedMonth && ` - ${selectedMonth}`}
              </span>
            </div>
            {applications.length === 0 ? (
              <div className="empty-state">
                <Briefcase size={48} />
                <h3>NO APPLICATIONS FOUND</h3>
                <p>
                  When you click on job links from Telegram, they will appear
                  here.
                </p>
              </div>
            ) : (
              <div
                style={{
                  padding: "0.5rem",
                  overflowX: "auto",
                  maxHeight: "500px",
                  overflowY: "auto",
                }}
              >
                <table className="jobs-table">
                  <thead>
                    <tr>
                      <th style={{ width: "26%" }}>JOB TITLE</th>
                      <th style={{ width: "13%" }}>COMPANY</th>
                      <th style={{ width: "13%" }}>LOCATION</th>
                      <th style={{ width: "10%" }}>ROLE TYPE</th>
                      <th style={{ width: "10%" }}>APPLIED</th>
                      <th style={{ width: "10%" }}>POSTED</th>
                      <th style={{ width: "10%" }}>DELAY</th>
                      <th style={{ width: "4%" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {applications.map((app) => {
                      const delayMinutes = calculateDelayMinutes(app.postedDate, app.appliedAt);
                      return (
                        <tr
                          key={app.id}
                          onClick={() => window.open(app.originalUrl, "_blank")}
                        >
                          <td className="job-title-cell">{app.jobTitle}</td>
                          <td className="company-cell">{app.company}</td>
                          <td className="location-cell">{app.location}</td>
                          <td style={{ color: "#ffcc00" }}>
                            {app.roleType || "N/A"}
                          </td>
                          <td className="date-cell">{formatShortDate(app.appliedAt)}</td>
                          <td className="date-cell">
                            {app.postedDate ? formatShortDate(app.postedDate) : "N/A"}
                          </td>
                          <td style={{
                            color: delayMinutes !== null
                              ? delayMinutes < 60 ? "#00ff88"
                              : delayMinutes < 1440 ? "#ffcc00"
                              : "#ff6b6b"
                              : "#6b7280",
                            fontWeight: "600",
                            fontSize: "0.7rem"
                          }}>
                            {formatDelayCompact(delayMinutes)}
                          </td>
                          <td>
                            <a
                              href={app.originalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="external-link"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink size={14} />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Comprehensive Statistics */}
          {analyticsData && (
            <div className="terminal-panel span-full">
              <div className="panel-header">
                <BarChart3 size={14} />
                <span>COMPREHENSIVE STATISTICS</span>
              </div>
              <div style={{ padding: "0.75rem", overflowX: "auto" }}>
                <table className="jobs-table">
                  <thead>
                    <tr>
                      <th style={{ width: "40%" }}>METRIC</th>
                      <th style={{ width: "20%", textAlign: "right" }}>VALUE</th>
                      <th style={{ width: "40%" }}>DETAILS</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ color: "#6b7280" }}>Total Applications</td>
                      <td
                        style={{
                          textAlign: "right",
                          color: "#00ff88",
                          fontWeight: "bold",
                        }}
                      >
                        {stats?.totalApplications || 0}
                      </td>
                      <td style={{ color: "#6b7280" }}>
                        Across {availableMonths.length} month(s)
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#6b7280" }}>Unique Companies</td>
                      <td
                        style={{
                          textAlign: "right",
                          color: "#9d4edd",
                          fontWeight: "bold",
                        }}
                      >
                        {analyticsData.totalCompanies}
                      </td>
                      <td style={{ color: "#6b7280" }}>
                        Top:{" "}
                        {analyticsData.companyData[0]?.name || "N/A"} (
                        {analyticsData.companyData[0]?.value || 0})
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#6b7280" }}>Unique Locations</td>
                      <td
                        style={{
                          textAlign: "right",
                          color: "#4cc9f0",
                          fontWeight: "bold",
                        }}
                      >
                        {analyticsData.totalLocations}
                      </td>
                      <td style={{ color: "#6b7280" }}>
                        Top:{" "}
                        {analyticsData.locationData[0]?.name || "N/A"} (
                        {analyticsData.locationData[0]?.value || 0})
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#6b7280" }}>Average Per Day</td>
                      <td
                        style={{
                          textAlign: "right",
                          color: "#ffcc00",
                          fontWeight: "bold",
                        }}
                      >
                        {analyticsData.avgPerDay}
                      </td>
                      <td style={{ color: "#6b7280" }}>
                        Most Active:{" "}
                        {analyticsData.mostActiveDay
                          ? `${analyticsData.mostActiveDay[0]} (${analyticsData.mostActiveDay[1]})`
                          : "N/A"}
                      </td>
                    </tr>
                    {analyticsData.industryData.length > 0 && (
                      <tr>
                        <td style={{ color: "#6b7280" }}>Industries</td>
                        <td
                          style={{
                            textAlign: "right",
                            color: "#06ffa5",
                            fontWeight: "bold",
                          }}
                        >
                          {analyticsData.industryData.length}
                        </td>
                        <td style={{ color: "#6b7280" }}>
                          Top:{" "}
                          {analyticsData.industryData[0]?.name || "N/A"} (
                          {analyticsData.industryData[0]?.value || 0})
                        </td>
                      </tr>
                    )}
                    {analyticsData.avgDelayMinutes !== null && (
                      <>
                        <tr>
                          <td style={{ color: "#6b7280" }}>Average Response Time</td>
                          <td
                            style={{
                              textAlign: "right",
                              color: "#ff6b6b",
                              fontWeight: "bold",
                            }}
                          >
                            {formatDelay(analyticsData.avgDelayMinutes)}
                          </td>
                          <td style={{ color: "#6b7280" }}>
                            Median: {formatDelay(analyticsData.medianDelayMinutes)}
                          </td>
                        </tr>
                        <tr>
                          <td style={{ color: "#6b7280" }}>Response Time Range</td>
                          <td
                            style={{
                              textAlign: "right",
                              color: "#00ff88",
                              fontWeight: "bold",
                            }}
                          >
                            {formatDelay(analyticsData.minDelayMinutes)}
                          </td>
                          <td style={{ color: "#6b7280" }}>
                            Fastest to Slowest: {formatDelay(analyticsData.minDelayMinutes)} → {formatDelay(analyticsData.maxDelayMinutes)}
                          </td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
