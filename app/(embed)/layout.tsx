export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#F2F2F4]">
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}
