FROM public.ecr.aws/lambda/python:3.12

# Install system dependencies for LaTeX and fonts
RUN if command -v dnf >/dev/null 2>&1; then \
      dnf -y install \
        texlive-xetex \
        texlive-collection-latex \
        texlive-collection-xetex \
        texlive-collection-fontsrecommended \
        texlive-euenc \
        texlive-mlmodern \
        fontconfig \
        freetype \
        && dnf clean all; \
    elif command -v yum >/dev/null 2>&1; then \
      yum -y install \
        texlive-xetex \
        texlive-collection-latex \
        texlive-collection-xetex \
        texlive-collection-fontsrecommended \
        texlive-euenc \
        texlive-mlmodern \
        fontconfig \
        freetype \
        && yum clean all; \
    else \
      echo "No package manager found" && exit 1; \
    fi

# Calibri fonts (must be provided locally due to licensing)
COPY cdk/lambda/fonts/calibri/ /opt/calibri/
RUN sh -c 'ls /opt/calibri/*.ttf >/dev/null 2>&1 || ls /opt/calibri/*.otf >/dev/null 2>&1'
RUN mkdir -p /usr/share/fonts/calibri \
    && cp -f /opt/calibri/*.[tT][tT][fF] /usr/share/fonts/calibri/ 2>/dev/null || true \
    && cp -f /opt/calibri/*.[oO][tT][fF] /usr/share/fonts/calibri/ 2>/dev/null || true \
    && fc-cache -f -v
RUN mkdir -p /var/task/fonts/calibri \
    && cp -f /opt/calibri/*.[tT][tT][fF] /var/task/fonts/calibri/ 2>/dev/null || true \
    && cp -f /opt/calibri/*.[oO][tT][fF] /var/task/fonts/calibri/ 2>/dev/null || true

# Python dependencies
COPY requirements.txt /var/task/requirements.txt
RUN pip install --no-cache-dir -r /var/task/requirements.txt

# Application code
COPY src/ /var/task/
COPY media/ /var/task/media/

ENV FONTCONFIG_PATH=/etc/fonts
ENV FONTCONFIG_FILE=/etc/fonts/fonts.conf
ENV FC_CACHEDIR=/tmp/fontconfig
ENV XDG_CACHE_HOME=/tmp
ENV HOME=/tmp
ENV TEXMFVAR=/tmp/texlive/texmf-var
ENV TEXMFCONFIG=/tmp/texlive/texmf-config

RUN mkdir -p /tmp/fontconfig /tmp/texlive/texmf-var /tmp/texlive/texmf-config

CMD ["lambda_function.handler"]
