"use client";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none">
      {/* Animated gradient background */}
      <div className="absolute inset-0 gradient-morph opacity-30" />
      
      {/* Floating blobs */}
      <div className="absolute top-0 left-0 w-96 h-96 bg-purple-500/20 blob float-animation" 
           style={{ animationDelay: "0s" }} />
      <div className="absolute top-1/4 right-0 w-80 h-80 bg-pink-500/20 blob float-animation" 
           style={{ animationDelay: "2s", animationDuration: "8s" }} />
      <div className="absolute bottom-0 left-1/4 w-72 h-72 bg-blue-500/20 blob float-animation" 
           style={{ animationDelay: "4s", animationDuration: "10s" }} />
      <div className="absolute bottom-1/4 right-1/3 w-64 h-64 bg-indigo-500/20 blob float-animation" 
           style={{ animationDelay: "6s", animationDuration: "12s" }} />
      
      {/* Subtle grid overlay */}
      <div 
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0, 0, 0, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 0, 0, 0.1) 1px, transparent 1px)
          `,
          backgroundSize: "50px 50px",
        }}
      />
    </div>
  );
}

