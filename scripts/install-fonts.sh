#!/usr/bin/env bash
# Installs a wide set of free Latin font families from the Ubuntu archive
# for the current user only, without root: each package is fetched with
# `apt-get download` and its TrueType and OpenType files are copied into
# ~/.local/share/fonts/<package>/. Packages already there are skipped, so a
# rerun adds only what the list gained. The settings page lists every
# family that writes English as soon as this finishes; GNOME Shell draws
# the new ones after the next login.
#
# Usage: scripts/install-fonts.sh
set -euo pipefail

packages=(
    # Sans
    fonts-adf-gillius fonts-adf-irianis fonts-adf-libris fonts-adf-switzera
    fonts-adf-universalis fonts-adf-verana fonts-adobe-sourcesans3
    fonts-adwaita-sans fonts-allerta fonts-atkinson-hyperlegible
    fonts-atkinson-hyperlegible-next fonts-averia-sans-gwf fonts-b612
    fonts-beteckna fonts-cabin fonts-cantarell fonts-clear-sans
    fonts-comfortaa fonts-crosextra-carlito fonts-dosis fonts-eurofurence
    fonts-go fonts-ibm-plex fonts-inter fonts-junction fonts-karla
    fonts-karmilla fonts-lato fonts-league-spartan fonts-manrope
    fonts-millimetre fonts-montserrat fonts-mplus fonts-national-park
    fonts-nunito fonts-open-sans fonts-opendin fonts-opendyslexic
    fonts-paratype fonts-play fonts-quicksand fonts-roboto-unhinted
    fonts-sil-andika fonts-sn-pro fonts-sora fonts-space-grotesk-otf
    fonts-tiresias fonts-tuffy fonts-ubuntu-classic fonts-yanone-kaffeesatz
    # Serif
    fonts-adf-accanthis fonts-adf-baskervald fonts-adf-berenis
    fonts-adf-ikarius fonts-adf-oldania fonts-adf-romande fonts-adf-solothurn
    fonts-adf-tribun fonts-averia-gwf fonts-averia-serif-gwf
    fonts-babelstone-modern fonts-cardo fonts-century-catalogue fonts-cmu
    fonts-crosextra-caladea fonts-ebgaramond fonts-ebgaramond-extra
    fonts-elstob fonts-essays1743 fonts-fanwood fonts-gfs-neohellenic
    fonts-goudybookletter fonts-junicode fonts-levien-museum fonts-lindenhill
    fonts-linuxlibertine fonts-lmodern fonts-oldstandard fonts-prociono
    fonts-quattrocento fonts-roboto-slab fonts-sil-charis fonts-sil-doulos
    fonts-sil-gentium-basic fonts-sil-gentiumplus fonts-solide-mirage
    fonts-vollkorn fonts-yrsa-rasa
    # Display, script and handwriting
    fonts-adf-mekanus fonts-aenigma fonts-apropal fonts-bajaderka
    fonts-bebas-neue fonts-blankenburg fonts-breip fonts-bwht
    fonts-cabinsketch fonts-cherrybomb fonts-chomsky fonts-comic-neue
    fonts-dancingscript fonts-dkg-handwriting fonts-dustin fonts-ecolier-court
    fonts-engadget fonts-f500 fonts-fantasma fonts-femkeklaver
    fonts-ferrite-core fonts-gamaliel fonts-georgewilliams
    fonts-gotico-antiqua fonts-havana fonts-humor-sans fonts-isabella
    fonts-joscelyn fonts-kaushanscript fonts-klaudia-berenika fonts-kristi
    fonts-larabie-deco fonts-larabie-straight fonts-larabie-uncommon
    fonts-le-murmure fonts-leckerli-one fonts-levien-typoscript fonts-lobster
    fonts-lobstertwo fonts-okolaks fonts-ottilie fonts-radisnoir fonts-rampart
    fonts-reggae fonts-roadgeek fonts-rocknroll fonts-routed-gothic
    fonts-rufscript fonts-sjfonts fonts-staypuft fonts-summersby
    fonts-tomsontalks fonts-train fonts-yusei-magic
    # Monospace
    fonts-3270 fonts-adwaita-mono fonts-agave fonts-anonymous-pro
    fonts-cascadia-code fonts-courier-prime fonts-dm-mono
    fonts-fantasque-sans fonts-firacode fonts-gnutypewriter fonts-hack
    fonts-hermit fonts-inconsolata fonts-jetbrains-mono fonts-kode-mono
    fonts-league-mono fonts-monofur fonts-monoid-halfloose fonts-mononoki
)

target="$HOME/.local/share/fonts"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

wanted=()
for package in "${packages[@]}"; do
    [[ -d "$target/$package" ]] || wanted+=("$package")
done
if ((${#wanted[@]} == 0)); then
    echo "All ${#packages[@]} font packages are already installed in $target."
    exit 0
fi

# Older or newer Ubuntu releases lack some of these; name them and go on.
mapfile -t offered < <(apt-cache show --no-all-versions "${wanted[@]}" 2>/dev/null | awk '/^Package: /{print $2}' | sort -u)
missing=$(comm -23 <(printf '%s\n' "${wanted[@]}" | sort) <(printf '%s\n' "${offered[@]}"))
if [[ -n $missing ]]; then
    echo "Not in this system's package archive, skipped: ${missing//$'\n'/ }"
fi
if ((${#offered[@]} == 0)); then
    exit 0
fi

echo "Downloading ${#offered[@]} font packages..."
(cd "$work" && apt-get download -qq "${offered[@]}")

empty=()
for package in "${offered[@]}"; do
    debs=("$work/${package}_"*.deb)
    dpkg-deb -x "${debs[0]}" "$work/unpacked"
    # Folders are kept because variants of one family share file names.
    # Symbolic links point into other packages; web fonts and Type 1 fonts
    # are not drawn by GNOME's text stack.
    while IFS= read -r -d '' path; do
        install -D -m 644 "$work/unpacked/$path" "$work/fonts/$package/${path#usr/share/fonts/}"
    done < <(find "$work/unpacked" -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' \) -printf '%P\0')
    rm -rf "$work/unpacked"
    if [[ -d $work/fonts/$package ]]; then
        mkdir -p "$target"
        mv "$work/fonts/$package" "$target/$package"
    else
        empty+=("$package")
    fi
done
if ((${#empty[@]})); then
    echo "No TrueType or OpenType files in:" "${empty[@]}"
fi

fc-cache "$target"
echo "Installed $((${#offered[@]} - ${#empty[@]})) font packages in $target."
