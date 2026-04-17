// Single source of truth for dashboard navigation.
// Used by the in-app Navbar AND the /api/embed/tabs endpoint that
// investors.html consumes — renaming a label here updates both.

export type NavItem = {
  label: string;
  href: string;
  iconName: string;       // matches an export from lucide-react
  embedSlug?: string;     // route under /embed/{slug} that mirrors `href`
  investorTab?: boolean;  // exposed in the investors dashboard
};

export const navItems: NavItem[] = [
  { label: 'MRR Revenue',     href: '/dashboard',                iconName: 'LayoutDashboard',       embedSlug: 'overview',  investorTab: true },
  { label: 'MRR Breakdown',   href: '/dashboard/breakdown',      iconName: 'PieChart',              embedSlug: 'breakdown', investorTab: true },
  { label: 'Churn',           href: '/dashboard/churn',          iconName: 'UserMinus',             embedSlug: 'churn',     investorTab: true },
  { label: 'Refunds',         href: '/dashboard/refunds',        iconName: 'RotateCcw' },
  { label: 'Reviews',         href: '/dashboard/reviews',        iconName: 'MessageSquare' },
  { label: 'Voice of Refund', href: '/dashboard/refund-voice',   iconName: 'MessageSquareWarning' },
  { label: 'NPS',             href: '/dashboard/nps',            iconName: 'Smile',                 embedSlug: 'nps',       investorTab: true },
];
