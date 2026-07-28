import localFont from "next/font/local";

// Formula 1 Display Wide — proprietary F1 brand font, loaded from a local copy.
// Check licensing before shipping this on a public site.
export const f1Wide = localFont({
  src: "../fonts/Formula1-Wide.otf",
  variable: "--font-f1-wide",
  display: "block",
});

export const berkeleyMono = localFont({
  src: "../fonts/BerkeleyMonoVariable.otf",
  variable: "--font-berkeley-mono",
  display: "swap",
});
